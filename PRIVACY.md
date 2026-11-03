# Privacy

LayerMap collects no personal data and makes no network requests.

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
- **How long:** each project keeps its three latest map versions, and a map unused for 30 days is
  deleted; an installed version of LayerMap that nothing started for a week is deleted too. You can
  delete the cache directory at any time.
- **What leaves your machine:** nothing, through LayerMap. The first time the plugins start a
  version of LayerMap, npm installs that pinned `layermap` package from the npm registry into the
  cache; later starts run it from there. LayerMap's tool results go to the AI agent that called them, under
  that agent provider's terms, like any file the agent reads.

Questions: [GitHub Issues](https://github.com/coffeecoproject/layermap/issues). Security reports:
see [SECURITY.md](SECURITY.md).
