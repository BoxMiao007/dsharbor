/* 候选乙改的交互：点左侧导航项，把对应设置换到右侧面板（不弹窗）。 */

function renderRail() {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.map(
    (item) =>
      `<button type="button" class="ico-item" data-nav="${item.id}" aria-current="false">${item.icon}<span class="txt">${item.label}</span></button>`,
  ).join("");
  nav.querySelectorAll(".ico-item").forEach((el) => {
    el.addEventListener("click", () => selectPanel(el.dataset.nav));
  });
}

/** 把某个导航项的设置换到右侧面板。 */
function selectPanel(id) {
  const item = NAV.find((entry) => entry.id === id);
  if (!item) return;
  document.querySelectorAll(".ico-item").forEach((el) => {
    el.setAttribute("aria-current", String(el.dataset.nav === id));
  });
  document.getElementById("p-ico").innerHTML = item.icon;
  document.getElementById("p-title").textContent = item.label;
  document.getElementById("p-body").innerHTML = item.body();
  document.querySelector(".panel").scrollTop = 0;
}

function initRailPanel() {
  renderRail();
  initMode();
  selectPanel("launch");
}
