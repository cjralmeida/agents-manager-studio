import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Studio marks (e.g. "<!-- studio:retrabalho -->") out; the footer of signed comments ("<sub>...</sub>") as plain text. */
function cleanMarkdown(text: string) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?sub>/g, '')
    .trim();
}

const components: Components = {
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold text-gray-100">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold text-gray-100">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold text-gray-100">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium text-gray-200">{children}</h5>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted">{children}</blockquote>,
  hr: () => <hr className="my-3 border-border" />,
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-panel px-1 py-0.5 font-mono text-[0.85em] text-gray-200">{children}</code>
    ),
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-panel p-3 font-mono text-xs text-gray-200">{children}</pre>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border bg-panel px-2 py-1 text-left font-medium text-gray-200">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

/** A task's description or comment, rendered from the Markdown the board and the agents write. */
export function TaskMarkdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed break-words text-gray-300">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {cleanMarkdown(text)}
      </Markdown>
    </div>
  );
}
