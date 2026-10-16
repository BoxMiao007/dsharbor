/* 候选页面共用的小交互，纯粹为了「摸一下能不能用」，没有任何数据逻辑：
   - 自绘下拉框（方案 B/C/D/E 都用它示意选择器，做法与正式界面的 Picker 一致）
   - 单选揭示（选「指定程序路径 / 通过 WSL 启动」时显出对应的输入行）
   - 侧栏导航（方案 B）：点导航切内容页
   - 日志块与分组的折叠：用原生 <details>，这里不管 */

// ---- 下拉框 ----
for (const root of document.querySelectorAll(".picker")) {
  const button = root.querySelector(".picker-btn");
  const label = root.querySelector(".picker-label");
  const list = root.querySelector(".picker-list");
  if (!button || !label || !list) continue;

  const options = [...list.querySelectorAll(".picker-option")];
  const close = () => {
    list.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    // 打开时不给任何一行加底色：底色只属于「指针正指向的那一项」
    list.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
  };

  button.addEventListener("click", () => (list.classList.contains("hidden") ? open() : close()));
  for (const option of options) {
    option.addEventListener("click", () => {
      for (const other of options) other.setAttribute("aria-selected", String(other === option));
      label.textContent = option.textContent.trim();
      close();
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) close();
  });
}

// ---- 单选揭示：data-reveal="mode=binary,wsl" ----
const radios = [...document.querySelectorAll('input[type="radio"]')];
function applyReveal() {
  for (const el of document.querySelectorAll("[data-reveal]")) {
    const [name, values] = el.dataset.reveal.split("=");
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    const wanted = (values || "").split(",");
    el.classList.toggle("hidden", !checked || !wanted.includes(checked.value));
  }
}
for (const radio of radios) radio.addEventListener("change", applyReveal);
applyReveal();

// ---- 侧栏导航（方案 B）：data-nav="<pane 名>" ----
const navs = [...document.querySelectorAll("[data-nav]")];
for (const nav of navs) {
  nav.addEventListener("click", () => {
    for (const other of navs) other.classList.toggle("cur", other === nav);
    for (const pane of document.querySelectorAll("[data-pane]")) {
      pane.classList.toggle("hidden", pane.dataset.pane !== nav.dataset.nav);
    }
  });
}

// ---- 轻提示：执行完给个交代 ----
const toast = document.createElement("div");
toast.className = "toast";
document.body.append(toast);
let toastTimer;
window.dshToast = (text) => {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
};

// 页面上所有“乬动作”按钮的统一反馈；真实实现里接的是实际命令。
for (const btn of document.querySelectorAll("[data-act]")) {
  btn.addEventListener("click", () => window.dshToast(`已执行：${btn.dataset.act}`));
}

// ---- 滑块：把当前档位写进 data-out 指向的元素 ----
for (const range of document.querySelectorAll('input[type="range"][data-out]')) {
  const out = document.querySelector(range.dataset.out);
  const labels = (range.dataset.labels || "").split(",");
  const sync = () => {
    if (out) out.textContent = labels[range.value] ?? range.value;
  };
  range.addEventListener("input", sync);
  sync();
}

// ---- 步进器：− / + 微调整数 ----
for (const step of document.querySelectorAll(".step")) {
  const input = step.querySelector("input");
  for (const btn of step.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      const min = Number(input.min || 1);
      const max = Number(input.max || 65535);
      const next = Number(input.value || 0) + Number(btn.dataset.delta || 0);
      input.value = String(Math.min(max, Math.max(min, next)));
    });
  }
}

// ---- 快捷参数 chip：点一下追加到目标输入框 ----
for (const chip of document.querySelectorAll(".chip[data-append]")) {
  chip.addEventListener("click", () => {
    const target = document.querySelector(chip.dataset.append);
    if (!target) return;
    target.value = `${target.value} ${chip.dataset.value}`.trim();
    window.dshToast(`已添加 ${chip.dataset.value}`);
  });
}

// ---- 命令面板：输入过滤 + ↑↓ 选择 + Enter 执行，Ctrl/⌘+K 聚焦 ----
for (const palette of document.querySelectorAll(".palette")) {
  const input = palette.querySelector(".p-search input");
  const items = [...palette.querySelectorAll(".p-item")];
  const empty = palette.querySelector(".p-empty");
  let cursor = 0;
  const shown = () => items.filter((item) => !item.classList.contains("hidden"));

  const draw = () => {
    const list = shown();
    for (const item of items) item.setAttribute("aria-selected", "false");
    if (!list.length) return;
    cursor = Math.max(0, Math.min(cursor, list.length - 1));
    list[cursor].setAttribute("aria-selected", "true");
    list[cursor].scrollIntoView({ block: "nearest" });
  };

  const filter = () => {
    const query = input.value.trim().toLowerCase();
    for (const item of items) {
      const text = `${item.dataset.keys || ""} ${item.textContent}`.toLowerCase();
      item.classList.toggle("hidden", query !== "" && !text.includes(query));
    }
    if (empty) empty.classList.toggle("hidden", shown().length > 0);
    cursor = 0;
    draw();
  };

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (event) => {
    const list = shown();
    if (event.key === "ArrowDown" && list.length) {
      event.preventDefault();
      cursor = (cursor + 1) % list.length;
      draw();
    } else if (event.key === "ArrowUp" && list.length) {
      event.preventDefault();
      cursor = (cursor - 1 + list.length) % list.length;
      draw();
    } else if (event.key === "Enter" && list[cursor]) {
      list[cursor].click();
    } else if (event.key === "Escape") {
      input.blur();
    }
  });

  for (const item of items) {
    item.addEventListener("click", () => window.dshToast(`已执行：${item.dataset.cmd || item.textContent.trim()}`));
  }
  filter();
}

// 打开 / 关闭覆盖式面板：按钮打开，点空白处关闭。
for (const btn of document.querySelectorAll("[data-palette-open]")) {
  btn.addEventListener("click", () => {
    const scrim = document.querySelector(btn.dataset.paletteOpen);
    scrim?.classList.remove("hidden");
    scrim?.querySelector(".p-search input")?.focus();
  });
}
for (const scrim of document.querySelectorAll(".scrim")) {
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) scrim.classList.add("hidden");
  });
}

document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
  const scrim = document.querySelector(".scrim");
  const input = scrim ? scrim.querySelector(".p-search input") : document.querySelector(".palette .p-search input");
  if (!input) return;
  event.preventDefault();
  scrim?.classList.remove("hidden");
  input.focus();
  input.select();
});
