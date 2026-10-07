import type { NodeInfo, PacketInput } from "./types.js";

/** 将解码树还原为结构化输入，用于重新编码做一致性核验 */
export function treeToInput(node: NodeInfo): PacketInput {
  if (node.kind === "message") {
    return { type: "message", address: node.address ?? "", args: node.args ?? [] };
  }
  return {
    type: "bundle",
    timetag: node.timetag ?? "1",
    elements: (node.children ?? []).map(treeToInput),
  };
}

/** 将树与偏移表渲染为纯文本（CLI 用） */
export function renderTree(node: NodeInfo, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  if (node.kind === "message") {
    const args = (node.args ?? [])
      .map((a) => (a.type === "s" ? `"${a.value}"` : a.type === "b" ? `blob(${a.value.length / 2}B)` : String(a.value)))
      .join(" ");
    lines.push(`${pad}message ${node.address} [${node.offset}..${node.offset + node.length}) ${args}`.trimEnd());
  } else {
    lines.push(`${pad}bundle timetag=${node.timetag} [${node.offset}..${node.offset + node.length})`);
    for (const c of node.children ?? []) lines.push(renderTree(c, indent + 1));
  }
  return lines.join("\n");
}

export function renderOffsets(node: NodeInfo, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}${node.kind} @${node.offset} len=${node.length}`);
  for (const f of node.fields) {
    const v = f.value === undefined ? "" : ` value=${JSON.stringify(f.value)}`;
    lines.push(`${pad}  ${f.name} @${f.offset} len=${f.length} pad=${f.padding}${v}`);
  }
  for (const c of node.children ?? []) lines.push(renderOffsets(c, indent + 1));
  return lines.join("\n");
}
