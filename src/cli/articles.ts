/**
 * 文章运维入口。
 *
 * ⚠ **平时改文章请用网页**（管理台 → 文章，[#50](https://github.com/Lkyloveaw/lkyloveaw-home/issues/50) 已落地）：
 * 本 CLI 是**逃生口** —— 真源在库，文件只是导入来源；需要「按文件重导」时才用它。
 *
 * 真源在 SQLite（票 #32）：文件只是**导入的来源**。启动时的首次导入只在「库里一篇文章都没有」时发生，
 * 所以「改了文件但站点没变」是**预期行为**，不是 bug；要让它生效就跑这里的 `--reimport`。
 *
 * 用法：
 *   node dist/cli/articles.js --list      列出库里的文章（含草稿与回收站）
 *   node dist/cli/articles.js --reimport  按 content/*.md 重导（没改动的不会写库、也不会堆修订）
 */
import { closeStore, initStore, listArticlesForAdmin } from '../store.js'
import { reimportArticlesFromDisk } from '../content.js'
import { config } from '../config.js'

function usage(): void {
  console.log(`文章运维入口 —— 真源是 SQLite，content/ 只是导入的来源。

用法：
  node dist/cli/articles.js --list       列出库里的文章（含草稿与回收站）
  node dist/cli/articles.js --reimport   按 ${config.contentDir} 重导

为什么需要 --reimport：真源搬进库之后，改文件对站点**没有影响**（启动时的首次导入只在库为空时发生）。
平时改文章请用网页（管理台 → 文章）；这个逃生口用于「文件改完要按文件重导」。`)
}

function main(): void {
  const argv = process.argv.slice(2)
  const has = (flag: string): boolean => argv.includes(flag)

  if (argv.length === 0 || has('--help') || has('-h')) {
    usage()
    process.exit(argv.length === 0 ? 1 : 0)
  }

  initStore()

  if (has('--list')) {
    const rows = listArticlesForAdmin()
    if (!rows.length) {
      console.log('库里的文章：0 篇')
    } else {
      console.log(`库里的文章：${rows.length} 篇`)
      for (const row of rows) {
        const state = row.deletedAt !== null ? '回收站' : row.draft === 1 ? '草稿' : '已发布'
        console.log(`  ${row.date}  ${state.padEnd(4)}  ${row.slug}  ${row.title}`)
      }
    }
    closeStore()
    process.exit(0)
  }

  if (has('--reimport')) {
    const summary = reimportArticlesFromDisk()
    closeStore()
    // 解析失败是**真失败**（有文件没进来），用退出码说出来；重名跳过不是失败。
    process.exit(summary.failed > 0 ? 1 : 0)
  }

  console.error(`认不出的参数：${argv.join(' ')}`)
  usage()
  process.exit(1)
}

main()
