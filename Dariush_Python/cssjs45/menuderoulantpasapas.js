(function () {
  let debugTreeIdCounter = 0;

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function nextTreeNodeId() {
    debugTreeIdCounter += 1;
    return "debugTreeNode_" + debugTreeIdCounter;
  }

  function isExpandableDebugValue(node) {
    if (!node || typeof node !== "object") return false;

    if (node.kind === "list" || node.kind === "tuple") {
      return Array.isArray(node.items) && node.items.length > 0;
    }

    if (node.kind === "dict") {
      return node.items && typeof node.items === "object" && Object.keys(node.items).length > 0;
    }

    if (node.kind === "object") {
      return node.attributes && typeof node.attributes === "object" && Object.keys(node.attributes).length > 0;
    }

    return false;
  }

  function getDebugNodeSummary(node) {
    if (!node || typeof node !== "object") {
      return escapeHtml(String(node));
    }

    if (node.kind === "simple") {
      return escapeHtml(node.value ?? "");
    }

    if (node.kind === "list") {
      return `[list: ${node.size ?? 0}]`;
    }

    if (node.kind === "tuple") {
      return `[tuple: ${node.size ?? 0}]`;
    }

    if (node.kind === "dict") {
      return `{dict: ${node.size ?? 0}}`;
    }

    if (node.kind === "object") {
      return `<${escapeHtml(node.python_type ?? "object")}>`;
    }

    return escapeHtml(node.value ?? "");
  }

  function renderDebugValueTree(label, node, path = "") {
  const safeLabel = escapeHtml(label ?? "");
  const expandable = isExpandableDebugValue(node);

  if (!node || typeof node !== "object") {
    return `
      <div class="debug-tree-row">
        <span class="debug-tree-label">${safeLabel}</span>
        <span class="debug-tree-sep"> = </span>
        <span class="debug-tree-value">${escapeHtml(String(node))}</span>
      </div>
    `;
  }

  if (!expandable || node.kind === "simple") {
    const typeText = node.python_type
      ? ` <span class="debug-tree-type">(${escapeHtml(node.python_type)})</span>`
      : "";

    return `
      <div class="debug-tree-row">
        <span class="debug-tree-label">${safeLabel}</span>
        <span class="debug-tree-sep"> = </span>
        <span class="debug-tree-value">${escapeHtml(node.value ?? "")}</span>${typeText}
      </div>
    `;
  }

  const contentId = nextTreeNodeId();
  const summary = getDebugNodeSummary(node);
  let childrenHtml = "";

  if (node.kind === "list" || node.kind === "tuple") {
    const items = Array.isArray(node.items) ? node.items : [];
    childrenHtml = items
      .map((child, index) => renderDebugValueTree(`[${index}]`, child, path + "." + index))
      .join("");
  } else if (node.kind === "dict") {
    const entries = node.items && typeof node.items === "object"
      ? Object.entries(node.items)
      : [];
    childrenHtml = entries
      .map(([key, child]) => renderDebugValueTree(key, child, path + "." + key))
      .join("");
  } else if (node.kind === "object") {
    const entries = node.attributes && typeof node.attributes === "object"
      ? Object.entries(node.attributes)
      : [];
    childrenHtml = entries
      .map(([key, child]) => renderDebugValueTree(key, child, path + "." + key))
      .join("");
  }

  return `
    <div class="debug-tree-node">
      <div class="debug-tree-row">
        <span class="debug-tree-label">${safeLabel}</span>
        <button
          type="button"
          class="debug-tree-toggle"
          data-target="${contentId}"
          aria-expanded="false"
          title="Dérouler / replier"
        >▶</button>
        <span class="debug-tree-sep"> = </span>
        <span class="debug-tree-summary">${summary}</span>
        <span class="debug-tree-type">(${escapeHtml(node.python_type ?? "")})</span>
      </div>

      <div id="${contentId}" class="debug-tree-children" style="display:none;">
        ${childrenHtml}
      </div>
    </div>
  `;
}

   
  

  function renderDebugVarsTree(title, varsObj) {
    const entries = Object.entries(varsObj || {});
    let html = `<div class="debug-tree-block">`;
    html += `<div class="debug-tree-title">${escapeHtml(title)}</div>`;

    if (entries.length === 0) {
      html += `<div class="debug-tree-empty">(aucune)</div>`;
      html += `</div>`;
      return html;
    }

    for (const [name, node] of entries) {
      html += renderDebugValueTree(name, node, name);
    }

    html += `</div>`;
    return html;
  }

 function bindDebugTreeToggles(rootElement) {
  if (!rootElement) return;

  const buttons = rootElement.querySelectorAll(".debug-tree-toggle");

  buttons.forEach((btn) => {
    btn.onclick = () => {
      const targetId = btn.getAttribute("data-target");
      if (!targetId) return;

      const target = document.getElementById(targetId);
      if (!target) return;

      const isHidden = target.style.display === "none" || target.style.display === "";
      target.style.display = isHidden ? "block" : "none";
      btn.textContent = isHidden ? "▼" : "▶";
      btn.setAttribute("aria-expanded", isHidden ? "true" : "false");
    };
  });
}

  window.DebugTreeMenu = {
    renderDebugVarsTree,
    bindDebugTreeToggles
  };
})();