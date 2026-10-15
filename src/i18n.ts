// 输出语言:理由、CLI 输出、警告与错误信息。
//
// 启动时定一次:ZGATE_LANG 优先,其次 LC_ALL / LC_MESSAGES / LANG(POSIX 的覆盖顺序)。
// 第一个非空值以 zh 开头用中文,否则英文;都没设也是英文。
//
// 文案就地写成 t("中文", "English"),不做 key + 语言包:两种写法挨着,改一处时不会忘了另一处。
// t() 要在用到时调用,不放模块顶层:顶层的值在 import 时就定死了,测试切语言切不动它。

export type Lang = "zh" | "en";

const LANG_VARS = ["ZGATE_LANG", "LC_ALL", "LC_MESSAGES", "LANG"] as const;

export function detectLang(env: Readonly<Record<string, string | undefined>>): Lang {
  for (const name of LANG_VARS) {
    const v = env[name];
    if (v !== undefined && v !== "") return v.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "en";
}

let current: Lang = detectLang(process.env);

export function lang(): Lang {
  return current;
}

/** 测试用:进程内切换语言。 */
export function setLang(l: Lang): void {
  current = l;
}

export function t(zh: string, en: string): string {
  return current === "zh" ? zh : en;
}
