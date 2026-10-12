export function tabLabels(views) {
  function directory(path) {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "." : path.slice(0, separator) || "/";
  }

  const pathsByName = new Map();
  const entries = views.map(view => {
    const labels = view.kind === "diff" ? view.title.split(" <-> ") : [view.title];
    const sources = labels.map(label => {
      // Canonical Git labels are SHA:path or reference (SHA):path.
      const git = /^(?:([0-9a-f]{40}|[0-9a-f]{64})|.+ \(([0-9a-f]{40}|[0-9a-f]{64})\)):(.+)$/i.exec(label);
      const path = git ? git[3] : label;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!pathsByName.has(name)) pathsByName.set(name, new Set());
      pathsByName.get(name).add(path);
      return {path, name, revision: git ? (git[1] || git[2]).slice(0, 7) : null};
    });
    return {view, sources};
  });

  const directories = new Map();
  for (const paths of pathsByName.values()) {
    if (paths.size < 2) continue;
    const names = Array.from(paths);
    const parts = names.map(path => directory(path).split("/"));
    names.forEach((path, index) => {
      let length = 1;
      while (length < parts[index].length && parts.some((other, otherIndex) =>
        otherIndex !== index &&
        other.slice(-length).join("/") === parts[index].slice(-length).join("/"))) length += 1;
      directories.set(path, parts[index].slice(-length).join("/") || "/");
    });
  }

  return new Map(entries.map(({view, sources}) => {
    const samePath = sources.every(source => source.path === sources[0].path);
    const name = samePath ? sources[0].name : sources.map(source => source.name).join(" ↔ ");
    let location = "";
    if (samePath) {
      location = directories.get(sources[0].path) || "";
    } else if (sources.some(source => directories.has(source.path))) {
      location = sources.map(source => directories.get(source.path) || directory(source.path)).join(" ↔ ");
    }
    const versions = sources.some(source => source.revision) ?
      sources.map(source => source.revision || "working tree").join(" ↔ ") :
      view.kind === "diff" && samePath ? "diff" : "";
    return [view.id, {name, description: [location, versions].filter(Boolean).join(" · ")}];
  }));
}
