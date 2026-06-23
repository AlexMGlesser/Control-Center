# FILE_READER_SKILL

## Purpose
Enable the local AI agent to read any file on the computer, list directories, and search for files. Since this runs locally with a trusted LLM, there are no access restrictions.

---

## Core Functions

### 1. Read File

**Purpose:** Read the contents of any file (text or binary).

**Function Name:** `readFile(filePath)`

**Parameters:**
- `filePath` (string): Absolute path to the file

**Returns:**
```json
{
  "success": true,
  "filePath": "/absolute/path/to/file.txt",
  "fileName": "file.txt",
  "fileType": "text/plain",
  "extension": "txt",
  "size": 1024,
  "sizeFormatted": "1 KB",
  "encoding": "utf-8",
  "created": "2026-06-22T10:30:00Z",
  "modified": "2026-06-22T14:45:30Z",
  "content": "file content here"
}
```

**Example Use:**
```
Agent: "Read the file C:\Users\Alex\Desktop\notes.txt"
→ Returns JSON with full content and metadata
```

---

### 2. List Directory

**Purpose:** List all files and folders in a directory.

**Function Name:** `listDirectory(dirPath, recursive=false)`

**Parameters:**
- `dirPath` (string): Absolute path to directory
- `recursive` (boolean, optional): If true, list all subdirectories recursively

**Returns:**
```json
{
  "success": true,
  "dirPath": "/path/to/directory",
  "itemCount": 15,
  "items": [
    {
      "name": "file1.txt",
      "type": "file",
      "size": 2048,
      "sizeFormatted": "2 KB",
      "extension": "txt",
      "modified": "2026-06-22T10:15:00Z"
    },
    {
      "name": "subfolder",
      "type": "directory",
      "itemCount": 5,
      "modified": "2026-06-22T09:00:00Z"
    }
  ]
}
```

**Example Use:**
```
Agent: "List all files in D:\Control-Center"
→ Returns array of files and folders with metadata

Agent: "List all files in D:\Control-Center recursively"
→ Returns nested directory structure
```

---

### 3. Get File Metadata

**Purpose:** Get detailed information about a file without reading its contents.

**Function Name:** `getFileMetadata(filePath)`

**Parameters:**
- `filePath` (string): Absolute path to file

**Returns:**
```json
{
  "success": true,
  "filePath": "/path/to/file.ext",
  "fileName": "file.ext",
  "fileType": "application/json",
  "extension": "json",
  "size": 4096,
  "sizeFormatted": "4 KB",
  "encoding": "utf-8",
  "created": "2026-06-20T08:00:00Z",
  "modified": "2026-06-22T14:30:00Z",
  "isReadable": true,
  "isText": true,
  "isBinary": false
}
```

**Example Use:**
```
Agent: "Check the size of D:\Control-Center\package.json"
→ Returns metadata without loading the full content
```

---

### 4. Search Files

**Purpose:** Search for files matching a name pattern or extension.

**Function Name:** `searchFiles(searchPath, pattern, maxResults=100)`

**Parameters:**
- `searchPath` (string): Directory to search in (can be recursive from root)
- `pattern` (string): File name pattern or extension (e.g., "*.json", "package*", "readme")
- `maxResults` (number, optional): Max number of results to return

**Returns:**
```json
{
  "success": true,
  "searchPath": "/path/to/search",
  "pattern": "*.json",
  "resultCount": 12,
  "results": [
    {
      "filePath": "/path/to/file.json",
      "fileName": "file.json",
      "size": 2048,
      "modified": "2026-06-22T10:15:00Z"
    }
  ]
}
```

**Example Use:**
```
Agent: "Find all .json files in C:\Users\Alex\Documents"
→ Returns list of matching files

Agent: "Find files named 'config*' in D:\Control-Center"
→ Returns config.js, config.txt, etc.
```

---

### 5. Get File Type Info

**Purpose:** Determine file type and encoding.

**Function Name:** `getFileTypeInfo(filePath)`

**Parameters:**
- `filePath` (string): Absolute path to file

**Returns:**
```json
{
  "success": true,
  "filePath": "/path/to/file",
  "fileName": "file",
  "extension": "js",
  "fileType": "text/javascript",
  "category": "code",
  "isText": true,
  "encoding": "utf-8",
  "language": "javascript",
  "description": "JavaScript source file"
}
```

**Example Use:**
```
Agent: "What type of file is app.js?"
→ Returns file type classification and language
```

---

## Supported File Types

### Text Files (Readable as UTF-8)
- Code: `.js`, `.py`, `.ts`, `.java`, `.cpp`, `.c`, `.go`, `.rs`, `.rb`, `.php`, `.cs`
- Web: `.html`, `.css`, `.xml`, `.json`, `.yml`, `.yaml`, `.toml`
- Markup: `.md`, `.txt`, `.rst`, `.tex`
- Config: `.conf`, `.config`, `.cfg`, `.ini`, `.env`
- Data: `.csv`, `.tsv`, `.sql`

### Binary Files (Read as Base64 or Hex)
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`, `.svg`
- Archives: `.zip`, `.rar`, `.7z`, `.tar`, `.gz`
- Documents: `.pdf`, `.docx`, `.xlsx`
- Audio/Video: `.mp3`, `.mp4`, `.wav`, `.avi`, `.mov`
- Executables: `.exe`, `.dll`, `.so`, `.onnx`

---

## Common Usage Patterns

### 1. Explore a Project Structure
```
readFile("D:\Control-Center\PROJECT_OVERVIEW.md")
→ Understand project overview

listDirectory("D:\Control-Center\control-app\server\services", recursive=true)
→ See all service modules

searchFiles("D:\Control-Center", "*.json")
→ Find all JSON config files
```

### 2. Read Multiple Related Files
```
getFileMetadata("C:\project\config.json")
→ Check if exists and get size

readFile("C:\project\config.json")
→ Read the configuration

readFile("C:\project\package.json")
→ Read dependencies
```

### 3. Find Code Files
```
searchFiles("D:\Control-Center", "*.js")
→ Find all JavaScript files

getFileTypeInfo("D:\Control-Center\app.js")
→ Confirm it's a JS file

readFile("D:\Control-Center\app.js")
→ Read the source code
```

### 4. Investigate Errors
```
listDirectory("D:\Control-Center\logs")
→ See what logs exist

readFile("D:\Control-Center\logs\error.log")
→ Read error details

searchFiles("D:\Control-Center", "*error*")
→ Find related error files
```

---

## Error Handling

All functions return structured responses:

### Success Response
```json
{
  "success": true,
  "data": { /* file or list data */ }
}
```

### Error Response
```json
{
  "success": false,
  "error": "File not found",
  "filePath": "/path/to/missing/file",
  "code": "ENOENT"
}
```

### Common Errors
- `ENOENT`: File or directory not found
- `EACCES`: Permission denied
- `EISDIR`: Path is a directory, not a file
- `ENOTDIR`: Path is a file, not a directory
- `ENOMEM`: Out of memory (file too large)

---

## Limitations & Safety Notes

✅ **What this skill CAN do:**
- Read any file on the computer
- Read binary files as Base64/Hex
- List all directories
- Search across the entire file system
- Handle very large files (streamed if needed)

⚠️ **What to watch for:**
- Very large files (>100 MB) may be slow
- Binary files return Base64, not raw binary
- System files may have permission issues
- Network paths may have latency

---

## Example Workflows

### Workflow 1: Debug a Configuration Issue
```
1. searchFiles("C:\Users\Alex", "*.json") → Find config files
2. readFile("C:\path\to\config.json") → Read the config
3. readFile("C:\path\to\.env") → Check environment vars
4. listDirectory("C:\path\to\config") → See config folder
```

### Workflow 2: Analyze Code
```
1. listDirectory("D:\project\src") → See source structure
2. searchFiles("D:\project\src", "*.js") → Find all JS files
3. readFile("D:\project\src\main.js") → Read main entry
4. readFile("D:\project\src\utils\helpers.js") → Read utilities
```

### Workflow 3: Check Logs
```
1. listDirectory("D:\logs") → See log files
2. getFileMetadata("D:\logs\app.log") → Check log size
3. readFile("D:\logs\app.log") → Read recent logs
4. searchFiles("D:\logs", "error*") → Find error logs
```

---

## Quick Reference

| Task | Function | Example |
|------|----------|---------|
| Read file | `readFile()` | `readFile("C:\file.txt")` |
| List folder | `listDirectory()` | `listDirectory("C:\folder")` |
| Get info | `getFileMetadata()` | `getFileMetadata("C:\file.txt")` |
| Search files | `searchFiles()` | `searchFiles("C:\", "*.json")` |
| File type | `getFileTypeInfo()` | `getFileTypeInfo("C:\file.js")` |

---

## Integration

When using this skill in prompts:
- Mention `FILE_READER_SKILL` to activate file reading capabilities
- Specify file paths clearly (use absolute paths)
- For recursive operations, add `recursive=true` parameter
- Check `success` flag in responses before using data

**Example Agent Prompt:**
> "Use FILE_READER_SKILL to read D:\Control-Center\PROJECT_OVERVIEW.md and summarize the architecture."

