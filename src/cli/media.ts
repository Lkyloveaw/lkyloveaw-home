/**
 * 孤图清理（规格 [#41](https://github.com/Lkyloveaw/lkyloveaw-home/issues/41)）：**显式、可预演、不自动**。
 *
 * ```
 * node dist/cli/media.js          只列清单 + 总字节（**预演**，不删任何东西）
 * node dist/cli/media.js --yes    真删
 * node dist/cli/media.js --force  越过「零引用」保护（配合 --yes 才真删）
 * ```
 *
 * 规矩（逐条来自规格）：
 * - **不自动调度** —— 只由人敲命令触发（user story 40）。
 * - **删前先给清单与总字节**（user story 37）。
 * - **`--yes` 才真删**（user story 39）。
 * - **只动媒体目录**，备份快照一个不碰（user story 41）。
 * - **读失败或解析失败 → 一个文件都不删**（user story 40/50）——
 *   「**读失败**」和「**真的没有引用**」必须走两条完全不同的路，
 *   否则一次读库失败就会把全部图片当成孤图清掉。
 * - 草稿与**历史修订**里引用的图也算被引用（user story 38）—— 退回旧版时不能断图。
 */
import fs from 'node:fs'
import { imageNamesInDoc, listMedia, mediaPath, orphanMedia } from '../media.js'
import { allArticleBodies, closeStore, initStore } from '../store.js'

function main(): void {
  const yes = process.argv.includes('--yes')
  const force = process.argv.includes('--force')

  let bodies: string[]
  try {
    initStore()
    bodies = allArticleBodies()
  } catch (err) {
    console.error('❌ 读不到文章正文，**一个文件都没删**：' + (err as Error).message)
    process.exitCode = 1
    return
  }

  // 解析失败也是「读失败」的一种 —— 同样一个都不删。
  const referenced = new Set<string>()
  const unparsable: number[] = []
  bodies.forEach((body, i) => {
    try {
      for (const name of imageNamesInDoc(JSON.parse(body))) referenced.add(name)
    } catch {
      unparsable.push(i + 1)
    }
  })
  if (unparsable.length) {
    console.error(
      `❌ 有 ${unparsable.length} 份正文解析失败（第 ${unparsable.slice(0, 5).join('、')} 份），**一个文件都没删**。`,
    )
    process.exitCode = 1
    return
  }

  const all = listMedia()
  const orphans = orphanMedia(referenced)
  const sizes = orphans.map((name) => {
    try {
      return fs.statSync(mediaPath(name)).size
    } catch {
      return 0
    }
  })
  const totalBytes = sizes.reduce((a, b) => a + b, 0)

  console.log(`文章与修订里引用的媒体：**${referenced.size}** 个`)
  console.log(`孤图：**${orphans.length}** 个，合计 ${(totalBytes / 1024).toFixed(1)} KiB`)
  orphans.forEach((name, i) => console.log(`  ${name}  ${((sizes[i] ?? 0) / 1024).toFixed(1)} KiB`))

  // 零引用保护：库读得动但没有引用、媒体目录却有东西 → 先别删（user story 50）。
  if (referenced.size === 0 && all.length > 0 && !force) {
    console.error('\n❌ 引用集是空的（库里一篇文章正文都没有），但媒体目录里有 ' + all.length + ' 个文件 —— **拒绝清理**。')
    console.error('   这可能是「配置指错了库」，而不是「真的没有文章」；照单删就是把图全清掉。')
    console.error('   如果这确实是全新站点（图传了、还没插进文章），加 `--force` 再跑。')
    process.exitCode = 1
    return
  }
  if (!orphans.length) {
    console.log('\n没有孤图，没什么可清的。')
    return
  }
  if (!yes) {
    console.log('\n这是**预演**：没有删任何东西。确认无误后加 `--yes` 再跑一次。')
    if (force) console.log('（本次带了 `--force`：零引用保护已越过。）')
    return
  }

  let deleted = 0
  for (const name of orphans) {
    try {
      fs.rmSync(mediaPath(name))
      deleted++
    } catch (err) {
      console.error(`  删不掉 ${name}：${(err as Error).message}`)
    }
  }
  console.log(`\n✅ 已删除 ${deleted} 个孤图（只动了媒体目录；备份快照与数据库都没碰）。`)
}

main()
closeStore()
