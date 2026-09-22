import type { WorkNode } from "../types";

const codeCollator = new Intl.Collator("uk", { numeric: true, sensitivity: "base" });

export function compareNodeCodes(left: Pick<WorkNode, "code" | "title">, right: Pick<WorkNode, "code" | "title">) {
  return codeCollator.compare(left.code, right.code) || left.title.localeCompare(right.title, "uk");
}
