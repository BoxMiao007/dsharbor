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
