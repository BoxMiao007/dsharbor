/**
 * 自绘滚动指示条（通用版）：滚动容器的原生滚动条已在样式里藏掉
 * （`scrollbar-width: none`），滚动时右边缘浮出一条细胶囊，停手约 1 秒后淡出。
 * 只做视觉反馈 + 拖拽，不拦内容事件，滚轮 / 键盘 / 触控板照旧。
 *
 * 滚动容器与挂载点都通过 getter 现取：主卡的滚动容器随分区切换换人、界面重建后
 * `.content-main` 也是新节点，固定引用会失效；内层元素（日志正文、版本下拉）
 * 传恒定引用的 getter 即可。
 *
 * 轨道挂在 holder（必须是定位上下文、且自己不滚）上，按滚动盒的实时矩形用 `left`
 * 贴住其右缘——不能用 CSS 默认的 `right: 0`：那只对「占满 holder 整行」的主卡恰好
 * 成立，日志正文 / 版本下拉是缩进的内层元素，`right: 0` 会偏到外层卡片的 padding 上。
 */
export interface ScrollThumbOptions {
  /** 当前滚动容器；返回 null（分区切换中、容器隐藏）时轨道整体隐藏。 */
  getScroller(): HTMLElement | null;
  /** 轨道挂载点（定位上下文、自身不滚）；每次 update 重新取，界面重建后仍能找回。 */
  getHolder(): HTMLElement | null;
  /** 胶囊上下各让进多少像素（避开容器圆角），可随令牌变化。 */
  inset(): number;
  /** 轨道层级（版本下拉里要压过列表的 z-index）。 */
  zIndex?: number;
}

export interface ScrollThumb {
  update(): void;
  /** 连轨道一起藏（下拉收起等场景：轨道虽透明但会吃那一条的指针事件）。 */
  hide(): void;
}

export function attachScrollThumb(options: ScrollThumbOptions): ScrollThumb {
  const { getScroller, getHolder, inset, zIndex } = options;
  const track = document.createElement("div");
  track.className = "scroll-track";
  if (zIndex !== undefined) track.style.zIndex = String(zIndex);
  const thumb = document.createElement("div");
  thumb.className = "scroll-thumb";
  track.appendChild(thumb);

  let idleTimer = 0;
  const show = (): void => {
    thumb.classList.add("visible");
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => thumb.classList.remove("visible"), 900);
  };

  const update = (): void => {
    const holder = getHolder();
    const scroller = getScroller();
    if (holder && track.parentElement !== holder) holder.appendChild(track);
    if (!holder || !scroller) {
      // 没有可贴的容器（分区切换中、容器隐藏、details 折叠）：
      // 轨道藏掉，别留一条吃点击的透明窄条。
      track.style.display = "none";
      return;
    }
    const rect = scroller.getBoundingClientRect();
    if (rect.height < 1) {
      track.style.display = "none";
      return;
    }
    track.style.display = "";
    const holderRect = holder.getBoundingClientRect();
    track.style.right = "auto";
    track.style.left = `${Math.round(rect.right - holderRect.left) - 5}px`;
    // 上下各让进 inset：胶囊贴到边就会骑在容器圆角上——那正是「滚动条穿出圆角」。
    const gap = inset();
    track.style.top = `${Math.round(rect.top - holderRect.top) + gap}px`;
    track.style.height = `${Math.max(0, Math.round(rect.height) - gap * 2)}px`;
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

  // 滚动容器可能随分区切换换人，监听挂不到具体节点上，就在 document 捕获阶段
  // 接住所有滚动、按 getter 现取的容器过滤。
  document.addEventListener(
    "scroll",
    (event) => {
      if (event.target !== getScroller()) return;
      update();
      // 拖动期间不跑这个计时器，否则按住不动 0.9 秒胶囊会在手里淡掉
      if (!dragState) show();
    },
    { capture: true, passive: true },
  );
  window.addEventListener("resize", update);

  // 按住胶囊上下拖 = 直接改滚动位置，位移按「胶囊能走的距离 ↔ 内容还能滚的距离」等比换算。
  let dragState: { pointerId: number; startY: number; startScrollTop: number; scale: number } | null = null;
  thumb.addEventListener("pointerdown", (event) => {
    const scroller = getScroller();
    if (!scroller) return;
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
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = dragState.startScrollTop + (event.clientY - dragState.startY) * dragState.scale;
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
