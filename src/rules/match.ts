// 规则层共用的文本判据。规则层漏判的常见原因不是逻辑错,是只想到了一种写法。

/**
 * 归一化一段命令行文本:只压缩空白,不转小写。
 *
 * `git branch -D x`(强制删除)和 `git branch -d x`(只删已合并的)转小写后就分不开了。
 * 大小写无关的判据(`rm` / `RM`、`--FORCE` / `--force`)由调用方自己加 `i` 标志。
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
 * 路径里是否出现某个目录段(不要求结尾)。
 * 按段比,不用 substring:`~/.sshx/key` 里含 `.ssh`,但它不是 ssh 目录。
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
 * 命令里是否出现某个词,按词边界匹配:挡掉 `reproduce.ts`、`--production-mode` 里的 `prod` 这类巧合。
 * `prod.yaml` 这种挡不掉是刻意的:多问一次的代价远低于漏掉生产环境。
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
 * 家目录的字面写法(`~`、`~/x`、`$HOME`、`${HOME}`)。`~user` 和任意变量都不展开:
 * 解析层不展开变量,规则层也不猜,猜错的方向恰好是漏判。
 */
const HOME_FORMS = ["~", "$home", "${home}"] as const;

/** `~` / `~/x` / `$HOME/x` → 家目录下的相对路径(小写,家目录本身为 "");不是这几种写法返回 null。 */
export function underHome(path: string): string | null {
  const p = path.toLowerCase();
  for (const form of HOME_FORMS) {
    if (p === form) return "";
    if (p.startsWith(form + "/")) return path.slice(form.length + 1).toLowerCase();
  }
  // 绝对路径也可能就是家目录,但规则层拿不到 $HOME,不猜。
  return null;
}

/** 路径的各段,去掉空段与 `.`。 */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * 从命令原文里提取输出重定向的目的地(`> f`、`>> f`、`>f`、`2> f`、`&> f`、`>| f`)。
 * fd 复制(`2>&1`、`>&2`)不是文件,输入重定向与 heredoc 不是写,引号里的 `>` 不是算子,都跳过。
 *
 * 规则层要自己扫一遍:过了适配器就分不清一个目标是命令参数还是 `>` 后面的文件,而两者严重程度完全不同。
 * `cat ~/.ssh/id_rsa` 是读,`echo k >> ~/.ssh/authorized_keys` 是写授权公钥;后者的 verb 跟左边的命令走,
 * 是 exec,按 verb 一刀切的规则会放过它。
 *
 * 引号只剥一层,变量不展开:`"$HOME/.ssh/x"` 原样返回 `$HOME/.ssh/x`,由 `underHome` 认字面的 `$HOME`。
 * `tee` 不在这里处理:解析层把它归为 write 并给出目标。
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
