/**
 * 自绘滚动指示条（通用版）：主卡那套（main.ts）的抽小版——滚动容器自己的原生滚动条
 * 已在 style.css 里藏起来（`scrollbar-width: none`），滚动时右边缘浮出一条细胶囊，
 * 停手约 1 秒后淡出。只做视觉反馈 + 拖拽，不拦内容事件，滚轮 / 键盘 / 触控板照旧。
 *
 * 轨道挂在 `holder`（必须是定位上下文、且自己不滚）上，按 `scroller` 的实时矩形定位：
 * 与主卡不同的是这里用 `left` 贴住滚动盒右缘——主卡占满 `.content-main` 整行、
 * CSS 里的 `right: 0` 恰好贴边，而日志正文 / 版本下拉都是缩进的内层元素，
 * `right: 0` 会偏到外层卡片的 padding 上。
 */
export interface ScrollThumb {
  update(): void;
  /** 连轨道一起藏（下拉收起等场景：轨道虽透明但会吃那一条的指针事件）。 */
  hide(): void;
}

export function attachScrollThumb(
  scroller: HTMLElement,
  holder: HTMLElement,
  inset: number,
  zIndex?: number,
): ScrollThumb {
  const track = document.createElement("div");
  track.className = "scroll-track";
  if (zIndex !== undefined) track.style.zIndex = String(zIndex);
  const thumb = document.createElement("div");
  thumb.className = "scroll-thumb";
  track.appendChild(thumb);
  holder.appendChild(track);

  let idleTimer = 0;
  const show = (): void => {
    thumb.classList.add("visible");
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => thumb.classList.remove("visible"), 900);
  };

  const update = (): void => {
    const rect = scroller.getBoundingClientRect();
    if (rect.height < 1) {
      // 容器当前不可见（分区隐藏、details 折叠等）：轨道藏掉，别留一条吃点击的透明窄条。
      track.style.display = "none";
      return;
    }
    track.style.display = "";
    const holderRect = holder.getBoundingClientRect();
    track.style.right = "auto";
    track.style.left = `${Math.round(rect.right - holderRect.left) - 5}px`;
    // 上下各让进 inset：胶囊贴到边就会骑在容器圆角上——那正是「滚动条穿出圆角」。
    track.style.top = `${Math.round(rect.top - holderRect.top) + inset}px`;
    track.style.height = `${Math.max(0, Math.round(rect.height) - inset * 2)}px`;
    const viewport = scroller.clientHeight;
    const total = scroller.scrollHeight;
    const trackHeight = track.clientHeight;
    if (total <= viewport + 1 || trackHeight <= 0) {
      thumb.style.height = "0px";
      return;
    }
    const height = Math.max(28, (viewport / total) * trackHeight);
    const top = (scroller.scrollTop / (total - viewport)) * (trackHeight - height);
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${top}px)`;
  };

  scroller.addEventListener("scroll", () => {
    update();
    // 拖动期间不跑这个计时器，否则按住不动 0.9 秒胶囊会在手里淡掉
    if (!dragState) show();
  }, { passive: true });
  window.addEventListener("resize", update);

  // 按住胶囊上下拖 = 直接改滚动位置，位移按「胶囊能走的距离 ↔ 内容还能滚的距离」等比换算。
  let dragState: { pointerId: number; startY: number; startScrollTop: number; scale: number } | null = null;
  thumb.addEventListener("pointerdown", (event) => {
    const travel = track.clientHeight - thumb.offsetHeight;
    const scrollable = scroller.scrollHeight - scroller.clientHeight;
    if (travel <= 0 || scrollable <= 1) return;
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scroller.scrollTop,
      scale: scrollable / travel,
    };
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add("dragging");
  });
  thumb.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    scroller.scrollTop = dragState.startScrollTop + (event.clientY - dragState.startY) * dragState.scale;
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    dragState = null;
    thumb.classList.remove("dragging");
    if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
    show();
  };
  const hide = (): void => {
    track.style.display = "none";
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  update();
  return { update, hide };
}
