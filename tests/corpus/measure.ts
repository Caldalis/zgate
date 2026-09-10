// shell 解析的「体检报告」—— 不断言，只报数。
//
// 为什么存在:SPEC.md §15 要求第 2 步做完汇报「哪些情况回落到 unknown」。
// 那个比例比「测试是否全绿」更能说明解析器写得好不好:
//   - 太高 ⇒ 解析器太保守,后面误拦率难看
//   - 太低 ⇒ 它在硬猜,漏判风险大
// 所以把它固化成一条可复跑的命令,每次改 shell.ts 都该看一眼数字往哪边动了。
//
//   bun run tests/corpus/measure.ts
//
// 语料在 commands.txt。注意它是手写的、按「Claude Code 干活时会发什么命令」
// 的印象列的,不是真实采样。§15.7 的 journal 跑起来之后应该换成从
// ~/.zgate/journal/ 捞的真实命令 —— 那个才是本项目自己的数字。

import { parseCommand } from "../../src/core/shell.ts";

const text = await Bun.file(new URL("./commands.txt", import.meta.url)).text();
const lines = text.split("\n").filter((l) => l.trim() !== "");

// heredoc 占多行,合并回一条命令
const commands: string[] = [];
for (let i = 0; i < lines.length; i += 1) {
  let cmd = lines[i]!;
  const m = /<<-?\s*'?"?([A-Za-z_]\w*)'?"?/.exec(cmd);
  if (m) {
    const delim = m[1]!;
    while (i + 1 < lines.length) {
      i += 1;
      cmd += "\n" + lines[i]!;
      if (lines[i]!.trim() === delim) break;
    }
  }
  commands.push(cmd);
}

const unknown: string[] = []; // null  ⇒ 调用方落 verb:"unknown" ⇒ SOFT(§4.2)
const silent: string[] = []; //  []    ⇒ 不产生任何 Action,整条不进管线
const blind: string[] = []; //   全 exec 且无目标 ⇒ 两轮规则都命中不了 ⇒ PASS
const verbs: Record<string, number> = {};
let informative = 0;

for (const cmd of commands) {
  const parsed = parseCommand(cmd);
  if (parsed === null) {
    unknown.push(cmd);
    continue;
  }
  if (parsed.length === 0) {
    silent.push(cmd);
    continue;
  }
  for (const c of parsed) verbs[c.verb] = (verbs[c.verb] ?? 0) + 1;
  if (parsed.every((c) => c.verb === "exec" && c.targets.length === 0)) blind.push(cmd);
  else informative += 1;
}

const n = commands.length;
const pct = (x: number, d: number): string => `${((x / d) * 100).toFixed(1)}%`;

console.log(`语料 ${n} 条\n`);
console.log(`  null → unknown   ${String(unknown.length).padStart(3)}  ${pct(unknown.length, n)}`);
console.log(`  [] → 无 Action   ${String(silent.length).padStart(3)}  ${pct(silent.length, n)}`);
console.log(`  解析出意图       ${String(n - unknown.length - silent.length).padStart(3)}  ${pct(n - unknown.length - silent.length, n)}`);

const totalVerbs = Object.values(verbs).reduce((a, b) => a + b, 0);
console.log(`\nverb 分布(${totalVerbs} 个意图):`);
for (const [v, c] of Object.entries(verbs).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(9)} ${String(c).padStart(3)}  ${pct(c, totalVerbs)}`);
}

// 这个数字和 unknown 同样重要:解析器「没看懂」时不落 unknown、
// 而是落成「exec 且无目标」的那部分,规则层拿到手上没有任何可判信息 ⇒ 静默放行。
console.log(`\n盲区(全 exec 且无目标,规则层看不到任何信息):`);
console.log(`  ${blind.length}/${blind.length + informative}  ${pct(blind.length, blind.length + informative)}`);

const dump = (title: string, list: readonly string[]): void => {
  console.log(`\n--- ${title} ---`);
  for (const c of list) console.log(`  ${JSON.stringify(c)}`);
};
dump("回落 unknown", unknown);
dump("不产生 Action", silent);
dump("盲区", blind);
