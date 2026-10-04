# Privacy

LayerMap collects no personal data and makes no network requests.

- **What it reads:** the files of the Git repository it runs in.
- **What it stores:** a map of that code (paths, declarations and the calls between them) in your
  user cache: `~/Library/Caches/layermap` on macOS, `$XDG_CACHE_HOME/layermap` or
  `~/.cache/layermap` on Linux, or `LAYERMAP_CACHE`. Nothing is written into the repository.
- **How long:** each project keeps its three latest map versions, and a map unused for 30 days is
  deleted. You can delete the cache directory at any time.
- **What leaves your machine:** nothing, through LayerMap. When the plugins start LayerMap, npx
  downloads the pinned `layermap` package from the npm registry. LayerMap's tool results go to the
  AI agent that called them, under that agent provider's terms, like any file the agent reads.

Questions: [GitHub Issues](https://github.com/coffeecoproject/layermap/issues). Security reports:
see [SECURITY.md](SECURITY.md).
