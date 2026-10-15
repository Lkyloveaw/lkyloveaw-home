/**
 * 错误文案脱敏：把「运行时异常的原文」换成类别文案。
 *
 * 为什么必须有：`error` 列同时承担了两个职责——**给人看的分类文案**与**异常的原始文本**。
 * 后者可能含完整的请求 URL，而实测确认过：喂 `http://ops:hunter2@ledger.internal.example/`
 * 进去，落库的是完整长句原文，**含内网主机名与口令**。
 *
 * ⚠ 核心判据是「**谁生成的**」，不是「有没有 code」：
 *
 * | 来源 | 处理 |
 * | --- | --- |
 * | `probe.ts` 自己拼的文案（`超时（>1500ms）`、`状态码 200 不在预期范围内`） | **原样保留** |
 * | 运行时异常（有 code） | 走类别码白名单 |
 * | 运行时异常（无 code） | **兜底成「探测失败」，绝不回原文** |
 *
 * 为什么不能「统一按 code 分类」：超时文案**没有 code**，统一分类会把「等了多久」抹成
 * 「探测失败」——那恰好摧毁了排障最需要的信息。本票第一版草案就是这样被实测推翻的。
 * 见 `docs/api-status-fields-decision.md` §4.2。
 *
 * 脱敏放在**写入侧**：`lastError`（页面卡片）与 `incidents[].error`（近期异常列表）
 * 从同一列读，写一次三处都干净；放在渲染侧要记得做三遍，而实测正是「差点漏掉 incidents 那处」。
 */

/** 我们自己生成的文案前缀。这些天然安全（只含状态码与超时值），必须原样保留。 */
const SELF_AUTHORED = [/^超时（>\d+ms）$/, /^状态码 \d+ 不在预期范围内$/]

/** 类别码 → 人话。**只映射，不回退到原文。** */
const CODE_LABELS: Record<string, string> = {
  ENOTFOUND: 'DNS 解析失败',
  EAI_AGAIN: 'DNS 解析失败',
  ECONNREFUSED: '连接被拒',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EPIPE: '连接中断',
  ECONNABORTED: '连接中止',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '响应头超时',
  UND_ERR_BODY_TIMEOUT: '响应体超时',
  UND_ERR_SOCKET: '套接字错误',
  ERR_INVALID_URL: 'URL 非法',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 版本不符',
}

/** 运行时异常里**可以**安全出网的 code 形态：只允许大写字母/数字/下划线。 */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/

/**
 * 判定一段落库的 `error` 文本是否「自己生成的」。
 * 自己生成的文案可以直接出网，也**必须**保住（信息量最大）。
 */
export function isSelfAuthored(text: string): boolean {
  return SELF_AUTHORED.some((re) => re.test(text))
}

/**
 * 把运行时异常收敛成类别文案。
 *
 * ⚠ 两条硬规矩（缺一不可，否则泄漏重新打开）：
 * 1. **优先用 code**，绝不用 `e.message`（原文可能含 URL 与凭证）；
 * 2. **没有 code 就兜底成「探测失败」**，不回退到任何原文。
 */
export function classifyRuntimeError(code: string | undefined | null): string {
  if (!code || typeof code !== 'string') return '探测失败'
  const key = code.trim()
  if (!SAFE_CODE.test(key)) return '探测失败'
  const label = CODE_LABELS[key]
  // 未映射的 code 只带 code 本身（形态已由 SAFE_CODE 保证安全），不带任何文本。
  return label ? `${label}（${key}）` : `探测失败（${key}）`
}

/**
 * 清洗一条**已落库**的 `error`。用于存量脏数据迁移。
 *
 * 与写入侧同规则，但入口是「一段字符串」，需要反推它的来源：
 * - 自身文案 → 原样；
 * - 形如 `XXXX`（单个大写码）→ 当类别码处理；
 * - 其余（长句原文、含 URL 的东西）→ 兜底成「探测失败」。
 *
 * 注意：**不能**尝试从原文里提取 code——那等于在解析不可信文本。
 * 存量数据无法可靠还原它的 code，所以一律按兜底处理。这是可接受的：
 * 旧数据的价值在状态与延迟，不在错误文案。
 */
export function sanitizeStoredError(raw: string | null): string | null {
  if (raw == null) return null
  const text = String(raw)
  if (!text) return text
  if (isSelfAuthored(text)) return text
  // 看起来就是个裸 code（旧库把 code 本身写成了 message 的情形）
  if (SAFE_CODE.test(text.trim())) return classifyRuntimeError(text.trim())
  return '探测失败'
}

/** 该条存量数据是否需要清洗（用于按主键分页扫描时跳过干净行）。 */
export function needsSanitizing(raw: string | null): boolean {
  if (raw == null) return false
  return sanitizeStoredError(raw) !== raw
}

/**
 * 出网前的最后一道闸：任何要进 JSON 响应或页面的错误文案都过这里。
 *
 * 与写入侧重复是有意的——**纵深防御**：万一有历史行绕过了迁移，
 * 这里仍然拦得住。判据同样是「自己生成的才放行」。
 */
export function forOutput(raw: string | null): string | null {
  if (raw == null) return null
  const text = String(raw)
  if (!text) return text
  if (isSelfAuthored(text)) return text
  // 映射过的类别文案（形如「连接被拒（ECONNREFUSED）」）放行
  if (/^[^（）]{2,20}（[A-Z][A-Z0-9_]{2,63}）$/.test(text)) return text
  if (text === '探测失败') return text
  return '探测失败'
}
