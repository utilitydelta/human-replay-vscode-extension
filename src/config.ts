import * as vscode from "vscode";
import { TemplateName } from "./templates";

export interface Config {
  enabled: boolean;
  apiBase: string;
  model: string;
  template: TemplateName;
  maxTokens: number;
  temperature: number;
  debounceMs: number;
  prefixChars: number;
  suffixChars: number;
  multiline: boolean;
}

// Clearing a text field in the settings UI stores "" rather than removing the
// key, and c.get's fallback only applies to an ABSENT key — so an emptied
// setting must fall back too, or "" flows downstream as a model name (Ollama
// 400s it) or an API base (every fetch fails).
function str(c: vscode.WorkspaceConfiguration, key: string, fallback: string): string {
  const v = c.get<string>(key, fallback).trim();
  return v === "" ? fallback : v;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration("humanReplay");
  return {
    enabled: c.get<boolean>("enabled", false),
    apiBase: str(c, "apiBase", "http://localhost:11434"),
    model: str(c, "model", "qwen2.5-coder:1.5b-base"),
    template: c.get<TemplateName>("template", "auto"),
    maxTokens: c.get<number>("maxTokens", 256),
    temperature: c.get<number>("temperature", 0.01),
    debounceMs: c.get<number>("debounceMs", 300),
    prefixChars: c.get<number>("prefixChars", 3000),
    suffixChars: c.get<number>("suffixChars", 1000),
    multiline: c.get<boolean>("multiline", true),
  };
}
