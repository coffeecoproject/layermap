export function buildProjectMapParser(directory: string): Promise<{
  resources: { workerPath: string; compilerPath: string };
  goResources: { workerPath: string; compilerPath: string };
  pythonResources: { workerPath: string; compilerPath: string };
  javaResources: JavaMapBuild;
  inputs: Record<string, string>;
}>;
export function buildGoMap(
  output: string,
  target?: { platform: "darwin" | "linux" | "win32"; arch: "arm64" | "x64" },
): Promise<string>;
export function buildPythonMap(
  directory: string,
  record?: (file: string) => Promise<void>,
): Promise<{ workerPath: string; compilerPath: string }>;
// Without a JDK the analyzer is not built: no runtime, and no jar at compilerPath.
export type JavaMapBuild = {
  workerPath: string;
  compilerPath: string;
  runtimePath?: string;
  runtimeVersion?: string;
};
export function findJava(): Promise<{ home: string; version: string }>;
export function buildJavaMap(
  directory: string,
  record?: (file: string) => Promise<void>,
): Promise<JavaMapBuild>;
