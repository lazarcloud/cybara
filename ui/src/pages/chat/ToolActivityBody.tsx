import { memo, useState } from "react";
import { DiffCodeBlock } from "./MessageContent";

const DIFF_PREVIEW_LINES = 300;

export function leadingLines(text: string, maxLines: number): { text: string; total: number } {
  let offset = 0;
  let count = 0;
  let cut = -1;
  while (offset <= text.length) {
    count += 1;
    if (count === maxLines + 1) cut = offset - 1;
    const next = text.indexOf("\n", offset);
    if (next === -1) break;
    offset = next + 1;
  }
  return cut < 0 ? { text, total: count } : { text: text.slice(0, cut), total: count };
}

function ToolDiffBody({ diff }: { diff: string }) {
  const [showAll, setShowAll] = useState(false);
  const preview = leadingLines(diff, DIFF_PREVIEW_LINES);
  const truncated = !showAll && preview.text.length < diff.length;
  return (
    <div data-testid="activity-diff-body">
      <DiffCodeBlock code={truncated ? preview.text : diff} className="my-1.5" />
      {truncated ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="chat-meta-text mb-1 cursor-pointer text-indigo-300 hover:text-indigo-200"
        >
          Show all {preview.total} lines
        </button>
      ) : null}
    </div>
  );
}

function ToolOutputBody({ output }: { output: string }) {
  return (
    <pre
      data-testid="activity-output-body"
      className="chat-code-surface max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 px-3 py-2 font-mono text-[12px] leading-5 text-gray-300"
    >
      {output}
    </pre>
  );
}

export const ToolActivityBody = memo(function ToolActivityBody({
  output,
  diff,
}: {
  output?: string;
  diff?: string;
}) {
  if (diff) return <ToolDiffBody diff={diff} />;
  if (output) return <ToolOutputBody output={output} />;
  return null;
});
