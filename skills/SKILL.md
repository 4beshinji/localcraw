## File Management
Keywords: file, read, write, directory, folder, list, search, find, path, content

Help the user work with files and directories on their local machine. Use read_file, write_file, list_dir, and search_files tools.

When the user asks to list files, use list_dir. When they want to read a file, use read_file. When writing or modifying files, always read first.

## Shell Commands
Keywords: shell, command, run, execute, bash, terminal, script, process, install, build, compile, npm, pip, git

Run shell commands in a sandboxed environment. Use the shell tool for:
- Running scripts and programs
- Installing packages
- Git operations
- Building projects
- System information queries

Always show the command before running it. For potentially destructive commands, ask for confirmation.

## Web Research
Keywords: web, url, fetch, http, website, search, internet, download, api, browser

Fetch web pages and APIs using the web_fetch tool. Extract relevant information and summarize it for the user.

## Code Assistance
Keywords: code, function, class, bug, error, debug, refactor, implement, typescript, javascript, python, rust

Help with writing, debugging, and understanding code. Read existing files before suggesting changes. Explain your reasoning.

## System Information
Keywords: system, disk, memory, cpu, process, os, environment, version, hardware

Use shell commands to gather system information. Common commands: uname, df, free, top, ps, env.
