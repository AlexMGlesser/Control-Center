import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

const VS_CODE_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".jsonc",
  ".html",
  ".htm",
  ".xhtml",
  ".shtml",
  ".vue",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".groovy",
  ".scala",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".swift",
  ".cs",
  ".fs",
  ".sql",
  ".r",
  ".dart",
  ".lua",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".dockerfile",
  ".make",
  ".gradle",
  ".properties",
  ".csv",
  ".tsv"
]);

const VS_CODE_TEXT_FILE_NAMES = new Set([
  "makefile",
  "dockerfile",
  "readme",
  "license",
  "changelog",
  ".gitignore",
  ".gitattributes",
  ".editorconfig"
]);

let hasVsCodeCli = null;

const WORK_PROJECTS = [
  {
    id: "work-1",
    name: "Work Project 1",
    path: "C:\\Users\\Alex\\Documents\\work\\project1"
  },
  {
    id: "work-2",
    name: "Work Project 2",
    path: "C:\\Users\\Alex\\Documents\\work\\project2"
  }
];

const PERSONAL_PROJECTS = [
  {
    id: "personal-1",
    name: "Personal Project 1",
    path: "D:\\Control-Center"
  },
  {
    id: "personal-2",
    name: "Personal Project 2",
    path: "C:\\Users\\Alex\\Documents\\projects\\project2"
  }
];

export function getWorkProjects() {
  return WORK_PROJECTS.map((project) => ({ ...project }));
}

export function getPersonalProjects() {
  return PERSONAL_PROJECTS.map((project) => ({ ...project }));
}

export function getProjectById(appType, projectId) {
  const projects = getProjectsCollection(appType);
  return projects.find((project) => project.id === projectId);
}

export function createProject(appType, name, projectPath) {
  const projects = getProjectsCollection(appType);
  const normalizedName = String(name || "").trim();
  const normalizedPath = String(projectPath || "").trim();

  if (!normalizedName) {
    throw createProjectError("INVALID_PROJECT_NAME", "Project name is required.", 400);
  }

  if (!normalizedPath) {
    throw createProjectError("INVALID_PROJECT_PATH", "Project path is required.", 400);
  }

  const resolvedPath = path.resolve(normalizedPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
    throw createProjectError("INVALID_PROJECT_PATH", "Project path must be an existing folder.", 400);
  }

  const duplicatePath = projects.some(
    (project) => normalizePathForCompare(project.path) === normalizePathForCompare(resolvedPath)
  );

  if (duplicatePath) {
    throw createProjectError("DUPLICATE_PROJECT_PATH", "This folder is already in your project list.", 409);
  }

  const projectPrefix = appType === "work-app" ? "work" : "personal";
  const projectId = buildUniqueProjectId(projectPrefix, normalizedName, projects);
  const project = {
    id: projectId,
    name: normalizedName,
    path: resolvedPath
  };

  projects.push(project);

  return {
    ok: true,
    project: { ...project }
  };
}

export function removeProject(appType, projectId) {
  const projects = getProjectsCollection(appType);
  const targetIndex = projects.findIndex((project) => project.id === projectId);

  if (targetIndex < 0) {
    throw createProjectError("PROJECT_NOT_FOUND", `Project '${projectId}' not found.`, 404);
  }

  const [removedProject] = projects.splice(targetIndex, 1);

  return {
    ok: true,
    project: { ...removedProject }
  };
}

export function buildFileTree(projectPath, maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) {
    return [];
  }

  try {
    const entries = readdirSync(projectPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });

    return entries.map((entry) => {
      const fullPath = path.join(projectPath, entry.name);
      const isDirectory = entry.isDirectory();
      const node = {
        name: entry.name,
        path: fullPath,
        type: isDirectory ? "folder" : "file"
      };

      if (isDirectory && currentDepth < maxDepth) {
        node.children = buildFileTree(fullPath, maxDepth, currentDepth + 1);
      }

      return node;
    });
  } catch {
    return [];
  }
}

export function createProjectNode(appType, projectId, parentPath, name, nodeType = "file") {
  const project = requireProject(appType, projectId);
  const safeName = normalizeNewNodeName(name);
  const targetType = nodeType === "folder" ? "folder" : "file";
  const destinationDirectory = resolveProjectPath(project.path, parentPath || project.path, false);

  if (!statSync(destinationDirectory).isDirectory()) {
    throw createProjectError("INVALID_DESTINATION", "Create target must be a folder.", 400);
  }

  const destinationPath = path.join(destinationDirectory, safeName);
  ensurePathDoesNotExist(destinationPath);

  if (targetType === "folder") {
    mkdirSync(destinationPath, { recursive: true });
  } else {
    writeFileSync(destinationPath, "", { flag: "wx" });
  }

  return {
    ok: true,
    path: destinationPath,
    node: buildNode(destinationPath)
  };
}

export function deleteProjectNode(appType, projectId, targetPath) {
  const project = requireProject(appType, projectId);
  const resolvedPath = resolveProjectPath(project.path, targetPath);

  if (resolvedPath === path.resolve(project.path)) {
    throw createProjectError("INVALID_DELETE_TARGET", "Project root cannot be deleted.", 400);
  }

  rmSync(resolvedPath, { recursive: true, force: false });

  return {
    ok: true,
    path: resolvedPath
  };
}

export function copyProjectNode(appType, projectId, sourcePath, destinationPath) {
  const project = requireProject(appType, projectId);
  const resolvedSourcePath = resolveProjectPath(project.path, sourcePath);
  const destinationDirectory = resolveDestinationDirectory(project.path, destinationPath);

  if (isSameOrNestedPath(resolvedSourcePath, destinationDirectory)) {
    throw createProjectError(
      "INVALID_COPY_DESTINATION",
      "Cannot copy a folder into itself or one of its children.",
      400
    );
  }

  const targetPath = getUniqueDestinationPath(destinationDirectory, path.basename(resolvedSourcePath));
  copyNodeRecursive(resolvedSourcePath, targetPath);

  return {
    ok: true,
    path: targetPath,
    node: buildNode(targetPath)
  };
}

export function moveProjectNode(appType, projectId, sourcePath, destinationPath) {
  const project = requireProject(appType, projectId);
  const resolvedSourcePath = resolveProjectPath(project.path, sourcePath);
  const destinationDirectory = resolveDestinationDirectory(project.path, destinationPath);

  if (isSameOrNestedPath(resolvedSourcePath, destinationDirectory)) {
    throw createProjectError(
      "INVALID_MOVE_DESTINATION",
      "Cannot move a folder into itself or one of its children.",
      400
    );
  }

  const targetPath = getUniqueDestinationPath(destinationDirectory, path.basename(resolvedSourcePath));

  try {
    renameSync(resolvedSourcePath, targetPath);
  } catch {
    copyNodeRecursive(resolvedSourcePath, targetPath);
    rmSync(resolvedSourcePath, { recursive: true, force: false });
  }

  return {
    ok: true,
    path: targetPath,
    node: buildNode(targetPath)
  };
}

export function openProjectNode(appType, projectId, targetPath) {
  const project = requireProject(appType, projectId);
  const resolvedPath = resolveProjectPath(project.path, targetPath);
  const nodeStats = statSync(resolvedPath);

  if (!nodeStats.isDirectory() && shouldOpenInEditor(resolvedPath)) {
    const openedInEditor = openPathInVsCode(resolvedPath);

    if (openedInEditor) {
      return {
        ok: true,
        path: resolvedPath,
        message: `Opened ${path.basename(resolvedPath)} in VS Code.`
      };
    }

    throw createProjectError(
      "VSCODE_NOT_AVAILABLE",
      "VS Code could not be launched. Install VS Code or enable the 'code' command, then try again.",
      409
    );
  }

  openPathWithShell(resolvedPath);

  return {
    ok: true,
    path: resolvedPath,
    message: `Opened ${path.basename(resolvedPath)}.`
  };
}

export function launchApp(toolName) {
  const tools = {
    vscode: {
      name: "Visual Studio Code",
      windows: "code",
      linux: "code",
      darwin: "code"
    },
    lmstudio: {
      name: "LMStudio",
      windows: "C:\\Users\\Alex\\AppData\\Local\\Programs\\LM Studio\\App\\lm-studio.exe",
      fallback: "start lm-studio",
      linux: "lm-studio",
      darwin: "open -a 'LM Studio'"
    },
    powershell: {
      name: "PowerShell",
      windows: "powershell",
      linux: "powershell",
      darwin: "open -a Terminal"
    },
    vmware: {
      name: "VMware Workstation",
      windows: "C:\\Program Files\\VMware\\VMware Workstation Pro\\vmware.exe",
      fallback: "vmrun",
      linux: "vmware",
      darwin: "open -a 'VMware Fusion'"
    },
    "android-studio": {
      name: "Android Studio",
      windows: "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe",
      fallback: "studio64",
      linux: "studio",
      darwin: "open -a 'Android Studio'"
    }
  };

  const tool = tools[toolName];
  if (!tool) {
    return {
      ok: false,
      code: "UNKNOWN_TOOL",
      message: `Unknown tool: ${toolName}`
    };
  }

  try {
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const command = tool[platform];

    spawn(command, { shell: true, detached: true, stdio: "ignore" });

    return {
      ok: true,
      message: `Launched ${tool.name}`
    };
  } catch (error) {
    if (tool.fallback) {
      try {
        spawn(tool.fallback, { shell: true, detached: true, stdio: "ignore" });
        return {
          ok: true,
          message: `Launched ${tool.name} (fallback)`
        };
      } catch {
        return {
          ok: false,
          code: "LAUNCH_ERROR",
          message: `Failed to launch ${tool.name}: ${error.message}`
        };
      }
    }

    return {
      ok: false,
      code: "LAUNCH_ERROR",
      message: `Failed to launch ${tool.name}: ${error.message}`
    };
  }
}

function requireProject(appType, projectId) {
  const project = getProjectById(appType, projectId);

  if (!project) {
    throw createProjectError("PROJECT_NOT_FOUND", `Project '${projectId}' not found.`, 404);
  }

  return project;
}

function getProjectsCollection(appType) {
  return appType === "work-app" ? WORK_PROJECTS : PERSONAL_PROJECTS;
}

function buildUniqueProjectId(prefix, name, projects) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");

  const baseId = `${prefix}-${slug || "project"}`;
  const existingIds = new Set(projects.map((project) => project.id));

  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseId}-${suffix}`;
}

function normalizePathForCompare(targetPath) {
  return String(targetPath || "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizeNewNodeName(name) {
  const normalizedName = String(name || "").trim();

  if (!normalizedName) {
    throw createProjectError("INVALID_NAME", "Name is required.", 400);
  }

  if (normalizedName === "." || normalizedName === ".." || /[\\/]/.test(normalizedName)) {
    throw createProjectError("INVALID_NAME", "Name must be a single file or folder name.", 400);
  }

  return normalizedName;
}

function resolveProjectPath(projectPath, targetPath, expectExisting = true) {
  const rootPath = path.resolve(projectPath);
  const resolvedPath = path.resolve(String(targetPath || rootPath));

  if (!isPathInsideProject(rootPath, resolvedPath)) {
    throw createProjectError("INVALID_PATH", "Path is outside the selected project.", 400);
  }

  if (expectExisting && !existsSync(resolvedPath)) {
    throw createProjectError("PATH_NOT_FOUND", `Path not found: ${resolvedPath}`, 404);
  }

  return resolvedPath;
}

function resolveDestinationDirectory(projectPath, destinationPath) {
  const resolvedPath = resolveProjectPath(projectPath, destinationPath);
  const stats = statSync(resolvedPath);
  return stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
}

function isPathInsideProject(projectPath, targetPath) {
  const relativePath = path.relative(projectPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSameOrNestedPath(sourcePath, candidatePath) {
  const relativePath = path.relative(sourcePath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function ensurePathDoesNotExist(targetPath) {
  if (existsSync(targetPath)) {
    throw createProjectError(
      "PATH_ALREADY_EXISTS",
      `${path.basename(targetPath)} already exists in this folder.`,
      409
    );
  }
}

function getUniqueDestinationPath(destinationDirectory, baseName) {
  const parsedPath = path.parse(baseName);
  let candidatePath = path.join(destinationDirectory, baseName);
  let copyIndex = 1;

  while (existsSync(candidatePath)) {
    const suffix = copyIndex === 1 ? "copy" : `copy-${copyIndex}`;
    const candidateName = parsedPath.ext
      ? `${parsedPath.name}-${suffix}${parsedPath.ext}`
      : `${parsedPath.name}-${suffix}`;

    candidatePath = path.join(destinationDirectory, candidateName);
    copyIndex += 1;
  }

  return candidatePath;
}

function copyNodeRecursive(sourcePath, destinationPath) {
  const stats = statSync(sourcePath);

  if (stats.isDirectory()) {
    mkdirSync(destinationPath, { recursive: true });
    const children = readdirSync(sourcePath);
    children.forEach((childName) => {
      copyNodeRecursive(path.join(sourcePath, childName), path.join(destinationPath, childName));
    });
    return;
  }

  copyFileSync(sourcePath, destinationPath);
}

function buildNode(targetPath) {
  const stats = statSync(targetPath);
  return {
    name: path.basename(targetPath),
    path: targetPath,
    type: stats.isDirectory() ? "folder" : "file"
  };
}

function openPathWithShell(targetPath) {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", targetPath], { detached: true, stdio: "ignore" })
      : process.platform === "darwin"
        ? spawn("open", [targetPath], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" });

  child.unref();
}

function shouldOpenInEditor(targetPath) {
  const baseName = path.basename(targetPath).toLowerCase();
  const extension = path.extname(baseName);

  if (VS_CODE_TEXT_EXTENSIONS.has(extension)) {
    return true;
  }

  return VS_CODE_TEXT_FILE_NAMES.has(baseName);
}

function openPathInVsCode(targetPath) {
  if (isVsCodeCliAvailable()) {
    const child = spawn("code", ["-r", targetPath], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32"
    });

    child.unref();
    return true;
  }

  const vscodeExecutable = getVsCodeExecutablePath();
  if (!vscodeExecutable) {
    return false;
  }

  const child = spawn(vscodeExecutable, [targetPath], {
    detached: true,
    stdio: "ignore",
    shell: false
  });

  child.unref();
  return true;
}

function isVsCodeCliAvailable() {
  if (typeof hasVsCodeCli === "boolean") {
    return hasVsCodeCli;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, ["code"], {
    stdio: "ignore",
    shell: process.platform === "win32"
  });

  hasVsCodeCli = result.status === 0;
  return hasVsCodeCli;
}

function getVsCodeExecutablePath() {
  if (process.platform !== "win32") {
    return null;
  }

  const executableCandidates = [
    "C:\\Users\\Alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe"
  ];

  return executableCandidates.find((candidatePath) => existsSync(candidatePath)) || null;
}

function createProjectError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
