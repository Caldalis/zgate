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
