# Privacy

LayerMap collects no personal data. Its only network requests are to the npm registry, to install
and update LayerMap itself.

- **What it reads:** the files of the Git repository it runs in. When mapping TypeScript and
  JavaScript, it also reads, on your machine, the packages installed under the project's
  `node_modules` that the compiler asks for, only to resolve types: their files do not become
  declarations or calls in the map. A link out of the project (`npm link`, a package store shared
  between projects, a `node_modules` that is itself a link) is not followed, and such a package
  counts as not installed, as do Yarn Plug'n'Play's archives. The tools say which packages they did
  not find.
- **What it stores:** a map of that code (paths, declarations and the calls between them), and a
  digest of what is installed to know when the map is out of date, in your
  user cache: `~/Library/Caches/layermap` on macOS, `$XDG_CACHE_HOME/layermap` or
  `~/.cache/layermap` on Linux, `%LOCALAPPDATA%\layermap\Cache` on Windows, or `LAYERMAP_CACHE`. Nothing is written into the repository.
- **What it logs:** for each tool call its MCP server answers, a line in `logs/calls.jsonl` in the
  same cache: the tool, its arguments, the repository, how long each step took and the first line
  of the answer, with no source. Past 2 MB the log is moved to `calls.1.jsonl`, replacing the one
  there, so it keeps at most about 4 MB.
- **How long:** each project keeps its three latest map versions, and a map unused for 30 days is
  deleted; of the installed versions of LayerMap the one the machine runs stays, and another is
  deleted a week after anything last ran it. You can delete the cache directory at any time.
- **What leaves your machine:** nothing of yours. LayerMap's launcher, which its plugins and
  `layermap setup` start, has npm install the latest `layermap` package from the npm registry into
  the cache, and while a session runs asks npm once an hour, with npm's own settings, which version
  is the latest; npm sends the registry only what any install or `npm view layermap` sends. LayerMap's tool results go to the AI agent that called them, under
  that agent provider's terms, like any file the agent reads.

Questions: [GitHub Issues](https://github.com/coffeecoproject/layermap/issues). Security reports:
see [SECURITY.md](SECURITY.md).
