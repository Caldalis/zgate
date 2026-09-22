// 规则层共用的文本判据。
//
// 这里的东西都很小,但每一条都对应一个真会出现的写法差异 —— 规则层
// 漏判的常见原因不是逻辑错,是**只想到了一种写法**。

/**
 * 归一化一段命令行文本。
 *
 * **只压缩空白,不转小写。** 这条看起来反直觉,但是踩过的坑:
 *
 *   `git branch -D feature/x` 和 `git branch -d feature/x` 是两条不同的
 *   命令 —— 前者强制删除,后者只删已合并的。转小写之后两者一模一样,
 *   规则层就永远判不出 -D 那一半。
 *
 * 所以大小写敏感的判据在调用方自己加 `i` 标志:
 *   - 认为大小写无关的(`rm` / `RM`、`--FORCE` / `--force`)→ 加 i
 *   - 真正大小写有意义的(`-D` vs `-d`)→ 不加
 *
 * 压缩空白则一律要做:`rm  -rf   /` 不该因为多打几个空格而逃过匹配。
 */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** 路径片段判断:path 是否以 suffix 结尾,且结尾处是路径分隔符边界。 */
export function endsWithSegment(path: string, suffix: string): boolean {
  if (!path.endsWith(suffix)) return false;
  const head = path.slice(0, path.length - suffix.length);
  return head === "" || head.endsWith("/");
}

/**
 * 路径里是否出现某个目录**段**(不要求结尾)。
 *
 * `.ssh` 这种判据必须按段比,不能 substring:`~/.sshx/key` 里含 `.ssh`,
 * 但它不是 ssh 目录。反过来说 `/etc/.ssh` 里 `.ssh` 是最后一段,也得算。
 */
export function hasSegment(path: string, segment: string): boolean {
  for (const part of path.split("/")) {
    if (part === segment) return true;
  }
  return false;
}

/** 取 basename,但保留 `~` 开头的写法(它后面还有信息)。 */
export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * 命令里是否出现某个词,按**词边界**匹配。
 *
 * 为什么不用 `text.includes("prod")`:`reproduce.ts` 里含 `prod`,
 * `--production-mode` 里也含。按词边界匹配能挡掉大部分这类巧合。
 * 挡不掉的(`prod.yaml`)是刻意的 —— 见 D8.6。
 */
const WORD_CACHE = new Map<string, RegExp>();

export function hasWord(text: string, word: string): boolean {
  let re = WORD_CACHE.get(word);
  if (re === undefined) {
    re = new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, "i");
    WORD_CACHE.set(word, re);
  }
  return re.test(text);
}

/**
 * 展开用户家目录的几种写法。
 *
 * 这里只处理**字面**写法(`~`、`~/x`、`$HOME`、`${HOME}`)。真正的
 * `~user` 和任意变量都展开不了 —— shell 解析层已经声明不展开变量
 * (D2.4),规则层不该偷偷猜,猜错的方向恰好是漏判。
 */
const HOME_FORMS = ["~", "$home", "${home}"] as const;

/** `~/x` / `$HOME/x` / `/Users/me/x` 都归一到「家目录下的相对路径」。 */
export function underHome(path: string): string | null {
  const p = path.toLowerCase();
  for (const form of HOME_FORMS) {
    if (p === form) return "";
    if (p.startsWith(form + "/")) return path.slice(form.length + 1).toLowerCase();
  }
  // 绝对路径也可能就是家目录,但规则层拿不到 $HOME,不猜。
  return null;
}

/** 归一化后判断两个字符串是否指同一类危险目标(用于 path 黑白名单)。 */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * 从命令原文里提取**输出重定向的目的地**(`> f`、`>> f`、`>f`、`2> f`、
 * `&> f`、`>| f`)。fd 复制(`2>&1`、`>&2`)不是文件,跳过(与 D2.6 一致);
 * 输入重定向与 heredoc 不是写,跳过;引号里的 `>` 不是算子。
 *
 * 为什么规则层要自己扫一遍:解析层给重定向目标打了 `from: "redirect"`
 * (D8.1),但那是 shell 层的中间态,适配器按 §2.1 只保留 kind/raw ——
 * 到规则层时已经分不清一个目标是命令参数还是 `>` 后面的文件。而这两者
 * 的严重程度完全不同:`cat ~/.ssh/id_rsa` 是读,`echo k >> ~/.ssh/authorized_keys`
 * 是往授权公钥里写。D2.5 让 verb 跟左边的命令走,所以后者的 verb 是 exec,
 * 按 verb 一刀切的规则会放过它 —— 这个漏判真的出现过(D12.2)。
 *
 * 引号只剥一层,变量不展开(D2.4):`"$HOME/.ssh/x"` 原样返回 `$HOME/.ssh/x`,
 * 由 `underHome` 认字面的 `$HOME`。`tee` 不在这里处理 —— 解析层把它归为
 * write 并给出目标,走 verb 那条路。
 */
export function redirectDestinations(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  let quote: "'" | '"' | null = null;

  const isBreak = (ch: string): boolean => /[\s;|&<>()]/.test(ch);

  while (i < n) {
    const c = text[i] ?? "";
    if (quote !== null) {
      if (c === "\\" && quote === '"') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; i += 1; continue; }
    if (c === "\\") { i += 2; continue; }
    if (c !== ">") { i += 1; continue; }

    // 算子:> / >> / >| ;前面可能紧贴 fd 数字或 &,那些字符已经被跳过了
    let j = i + 1;
    if (text[j] === ">") j += 1;
    if (text[j] === "|") j += 1;
    while (j < n && /\s/.test(text[j] ?? "")) j += 1;
    if (text[j] === "&") { i = j + 1; continue; } // fd 复制:2>&1 / >&2 / >&-

    // 读一个词,引号内原样收下
    let word = "";
    while (j < n) {
      const d = text[j] ?? "";
      if (d === "'" || d === '"') {
        const close = text.indexOf(d, j + 1);
        if (close === -1) { word += text.slice(j + 1); j = n; break; }
        word += text.slice(j + 1, close);
        j = close + 1;
        continue;
      }
      if (isBreak(d)) break;
      word += d;
      j += 1;
    }
    if (word !== "") out.push(word);
    i = Math.max(j, i + 1);
  }
  return out;
}
