import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  title: string;
  status?: string;
  lines: string[];
  className?: string;
}

export function TerminalPane({ title, status, lines, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const printedRef = useRef(0);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      convertEol: true,
      rows: 20,
      cursorBlink: false,
      disableStdin: true,
      theme: {
        background: "#101014",
        foreground: "#d9e0ee",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    for (let i = printedRef.current; i < lines.length; i += 1) {
      terminalRef.current.writeln(lines[i]);
    }
    printedRef.current = lines.length;
  }, [lines]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (lines.length < printedRef.current) {
      terminalRef.current.reset();
      for (const line of lines) {
        terminalRef.current.writeln(line);
      }
      printedRef.current = lines.length;
    }
  }, [lines.length, lines]);

  return (
    <section className={`terminal-pane ${className ?? ""}`.trim()}>
      <header className="terminal-header">
        <strong>{title}</strong>
        {status ? <span className="status-chip">{status}</span> : null}
      </header>
      <div ref={containerRef} className="terminal-body" />
    </section>
  );
}
