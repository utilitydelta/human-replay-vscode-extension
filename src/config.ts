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

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration("replayTab");
  return {
    enabled: c.get<boolean>("enabled", true),
    apiBase: c.get<string>("apiBase", "http://localhost:11434"),
    model: c.get<string>("model", "qwen2.5-coder:1.5b-base"),
    template: c.get<TemplateName>("template", "auto"),
    maxTokens: c.get<number>("maxTokens", 256),
    temperature: c.get<number>("temperature", 0.01),
    debounceMs: c.get<number>("debounceMs", 300),
    prefixChars: c.get<number>("prefixChars", 3000),
    suffixChars: c.get<number>("suffixChars", 1000),
    multiline: c.get<boolean>("multiline", true),
  };
}
