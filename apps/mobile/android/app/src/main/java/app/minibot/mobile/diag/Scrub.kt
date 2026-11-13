package app.minibot.mobile.diag

// 上传前的脱敏：应用目录、以及形似密钥的字符串。与电脑端 packages/core/src/diag/scrub.ts 同一套规则。

const val REDACTED_SHAPE = "[REDACTED]"

private val BEARER = Regex("""\bBearer\s+[A-Za-z0-9._~+/=-]{8,}""", RegexOption.IGNORE_CASE)
private val SK_KEY = Regex("""\bsk-[A-Za-z0-9_-]{8,}""")
// 32 位以上、同时含字母和数字的连续字符：像随机生成的令牌
private val LONG_TOKEN = Regex("""(?<![A-Za-z0-9_+-])(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{32,}""")
// 整段恰好是一个 UUID 时保留（线程 id、设备号等，便于排查），与电脑端一致
private val UUID_SHAPE = Regex("""^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$""")
private val FRAME = Regex("""^\s*at\s+.+$""")

/** 路径脱敏用的上下文：应用私有目录 → <app>，用户目录 → ~ */
data class ScrubContext(val appDir: String, val home: String)

/** 没登记过的密钥的形态过滤：sk-…、Bearer …、长随机串 → [REDACTED] */
fun redactLike(text: String): String =
    text.replace(BEARER, REDACTED_SHAPE).replace(SK_KEY, REDACTED_SHAPE).replace(LONG_TOKEN) { if (UUID_SHAPE.matches(it.value)) it.value else REDACTED_SHAPE }

/** 应用私有目录 → <app>，用户主目录 → ~ */
fun scrubPaths(text: String, ctx: ScrubContext): String {
    var out = text
    if (ctx.appDir.isNotEmpty()) out = out.replace(ctx.appDir, "<app>")
    if (ctx.home.isNotEmpty()) out = out.replace(ctx.home, "~")
    return out
}

/** 只保留栈帧里的类名与行号，去掉绝对路径；总长封顶 4096 字符 */
fun scrubStack(stack: String, ctx: ScrubContext): String {
    val frames = mutableListOf<String>()
    var total = 0
    for (line in stack.lineSequence()) {
        if (!FRAME.matches(line)) continue
        val frame = scrubPaths(line.trim(), ctx)
        val size = frame.length + if (frames.isEmpty()) 0 else 1
        if (total + size > 4096) break
        total += size
        frames.add(frame)
    }
    return frames.joinToString("\n")
}
