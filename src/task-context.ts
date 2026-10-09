/**
 * Minimal, non-sensitive task context derived from operational MCP tool arguments.
 * Never copy commands, file contents, or absolute paths into monitoring snapshots.
 * The path is used only to identify the repository under a /dev/<project> directory.
 */
const PROJECT_PATH = /(?:^|[\\/])dev[\\/]([\p{L}\p{N}_.-]{2,64})(?=$|[\\/\s"'\x60])/iu;
const GENERIC_FOLDERS = new Set(["node_modules", "dist", "build", "src", "tools", ".git", ".cache"]);

export function projectFromToolArguments(arguments_: unknown): string | undefined {
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
    return undefined;
  }
  const args = arguments_ as Record<string, unknown>;
  for (const key of ["workdir", "cwd", "path", "sourcePath", "destinationPath", "cmd"]) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const match = PROJECT_PATH.exec(value);
    const project = match?.[1];
    if (project && !GENERIC_FOLDERS.has(project.toLowerCase())) {
      return project;
    }
  }
  return undefined;
}
