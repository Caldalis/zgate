// shell 解析的「体检报告」—— 不断言,只报数:
//
//   bun run tests/corpus/measure.ts
//
// 回落 unknown 的比例比测试全绿更能说明解析器的好坏:太高 ⇒ 太保守,误拦多;太低 ⇒ 在硬猜,漏判风险大。
// 改解析器后看一眼数字往哪边动了。
// 语料 commands.txt 是按「Claude Code 干活时会发什么命令」的印象手写的,不是真实采样,
// 日后应换成从 ~/.zgate/journal/ 捞的真实命令。

import { parseCommand } from "../../src/shell/index.ts";

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

const unknown: string[] = []; // null  ⇒ 调用方落 verb:"unknown" ⇒ SOFT
const silent: string[] = []; //  []    ⇒ 解析器不产生 Action(适配器会补一条 unknown)
const blind: string[] = []; //   全 exec 且无目标 ⇒ 只剩文本规则能命中,否则 PASS
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
