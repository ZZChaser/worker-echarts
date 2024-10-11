/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */

import type {
  DataZoomComponentOption,
  ECharts,
  InsideDataZoomComponentOption,
  init as baseInit,
} from "echarts";
import { parse } from "telejson";

type Theme = Parameters<typeof baseInit>[1];
type InitOption = Parameters<typeof baseInit>[2];

type CanvasEChartsConstructorParams = [HTMLDivElement, Theme?, InitOption?];

const mouseEvents = [
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mouseover",
  "mouseout",
  "mousemove",
  "contextmenu",
  "wheel",
] as const;

export default class CanvasECharts {
  static async init(
    ...args: CanvasEChartsConstructorParams
  ): Promise<CanvasECharts> {
    return await new Promise((resolve) => {
      const instance = new this(...args);
      instance.onInitialized = () => {
        resolve(instance);
      };
    });
  }

  worker: Worker;
  onInitialized: <T = CanvasECharts>(instance: T) => void = () => {};
  canvas: HTMLCanvasElement;
  listenersMap = new Map<string, ((...args: unknown[]) => void)[]>();

  tipDom: HTMLDivElement | null = null;
  tipContent: string = "";
  hideTipTimer: NodeJS.Timeout | null = null;
  lockTip: boolean = false;

  echartsOption: echarts.EChartsOption = {};

  constructor(...params: CanvasEChartsConstructorParams) {
    const [divElement, theme, option = {}] = params;

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    divElement.appendChild(canvas);
    this.canvas = canvas;

    this.worker = this.getWorker();

    const offscreen = canvas.transferControlToOffscreen();
    option.devicePixelRatio ??= window.devicePixelRatio;
    const devicePixelRatio = option.devicePixelRatio;
    const { width, height } = canvas.getBoundingClientRect();
    offscreen.width = width * devicePixelRatio;
    offscreen.height = height * devicePixelRatio;

    this.worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        theme,
        option,
      },
      [offscreen]
    );
    this.worker.addEventListener(
      "message",
      (event) => {
        if (event.data.type === "initialized") {
          this.onInitialized(this);
        }
      },
      { once: true }
    );

    this.registerMouseEvents();
    this.workerListener();
    this.initTip();
    this.registerEChartsEvents();
  }

  /**
   * Get or create a worker for the given canvas.
   */
  protected getWorker(): Worker {
    return new Worker(new URL("./worker", import.meta.url));
  }

  /**
   * Register mouse events for the canvas.
   */
  private registerMouseEvents(): void {
    mouseEvents.forEach((type) => {
      this.canvas.addEventListener(type, (event) => {
        if (event.type === "wheel") {
          let usedDataZoom: DataZoomComponentOption[] = [];
          const option = this.echartsOption;
          if (option.dataZoom) {
            usedDataZoom = Array.isArray(option.dataZoom)
              ? option.dataZoom
              : [option.dataZoom];
          }

          const enabledDataZoomItem = usedDataZoom.find(
            (item) =>
              item.type === "inside" &&
              (item as InsideDataZoomComponentOption).disabled !== true
          );
          if (enabledDataZoomItem) {
            // wheel event should be prevented (to disable parent element scroll) when dataZoom is enabled.
            event.preventDefault();
          }
        }

        this.worker.postMessage({
          type: "event",
          event: {
            type: event.type,
            offsetX: event.offsetX,
            offsetY: event.offsetY,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wheelDelta: (event as any).wheelDelta,
          },
        });
      });
    });
  }

  private workerListener(): void {
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<{ type: string; data: unknown }>) => {
        const scope = "echarts:";
        const type = event.data.type;

        if (type.startsWith(scope)) {
          const listeners = this.listenersMap.get(type.slice(scope.length));
          listeners?.forEach((listener) => {
            listener(event.data.data);
          });
        }
      }
    );
  }

  private initTip(): void {
    this.tipDom = document.createElement("div");

    this.tipDom.addEventListener("mouseenter", () => {
      this.lockTip = true;

      if (this.hideTipTimer) {
        clearTimeout(this.hideTipTimer);
      }
    });
    this.tipDom.addEventListener("mouseleave", () => {
      this.lockTip = false;
      this.setHideTipTimer();
    });

    const baseStyle = {
      position: "absolute",
      display: "none",
      top: "0px",
      left: "0px",
      opacity: "0",
      visibility: "hidden",
      "will-change": "transform",
      "border-style": "solid",
      "border-width": "1px",
      "border-radius": "4px",
      "white-space": "nowrap",
      "box-shadow": "rgba(0, 0, 0, 0.2) 1px 2px 10px",
      transition:
        "opacity 0.2s cubic-bezier(0.23, 1, 0.32, 1), visibility 0.2s cubic-bezier(0.23, 1, 0.32, 1), transform 0.4s cubic-bezier(0.23, 1, 0.32, 1)",
    };
    Object.assign(this.tipDom.style, baseStyle);

    document.body.appendChild(this.tipDom);
  }

  private setHideTipTimer(): void {
    if (this.hideTipTimer) {
      clearTimeout(this.hideTipTimer);
    }

    this.hideTipTimer = setTimeout(() => {
      Object.assign(this.tipDom!.style, {
        opacity: "0",
        visibility: "hidden",
      });
    }, 100);
  }

  private registerEChartsEvents(): void {
    this.on("showTip", async (data) => {
      if (!this.tipDom) {
        return;
      }

      if (!this.tipContent) {
        return;
      }

      if (this.hideTipTimer) {
        clearTimeout(this.hideTipTimer);
      }

      const tooltip = this.echartsOption.tooltip;
      const usedTooltip = Array.isArray(tooltip) ? tooltip[0] : tooltip;

      if (!usedTooltip) {
        return;
      }

      const extraStyle =
        usedTooltip.extraCssText?.split(";").reduce((acc, styleString) => {
          const [property, value] = styleString
            .split(":")
            .map((item) => item.trim());
          if (property && value) {
            acc[property] = value;
          }
          return acc;
        }, {} as Record<string, string>) ?? {};

      Object.assign(extraStyle, {
        "pointer-events": usedTooltip.enterable ?? false ? "auto" : "none",
        "border-color": usedTooltip.borderColor,
        "background-color": usedTooltip.backgroundColor,
        color: usedTooltip.textStyle?.color,
        "font-size": usedTooltip.textStyle?.fontSize,
      });

      this.tipDom.innerHTML = this.tipContent;

      const dataPosition = data as { x: number; y: number };
      const { left, top } = this.tipSafePosition({
        originPosition: { left: dataPosition.x, top: dataPosition.y },
        offset: [10, 10],
      });

      Object.assign(this.tipDom.style, {
        ...extraStyle,
        opacity: "1",
        display: "block",
        visibility: "visible",
        transform: `translate3d(${Math.ceil(left)}px, ${Math.ceil(
          top
        )}px, 0px)`,
      });
    });

    this.on("hideTip", () => {
      if (this.lockTip) {
        return;
      }

      this.setHideTipTimer();
    });

    this.on("optionChange", (newOption) => {
      this.setHideTipTimer();
      this.echartsOption = parse(newOption as string) as echarts.EChartsOption;
    });
  }

  private tipSafePosition(params: {
    originPosition: { left: number; top: number };
    offset?: [number, number];
  }): { left: number; top: number } {
    const { originPosition, offset = [0, 0] } = params;
    const containerRect = this.canvas.getBoundingClientRect();
    const tipRect = this.tipDom!.getBoundingClientRect();
    let left = containerRect.left + originPosition.left + offset[0];
    let top = containerRect.top + originPosition.top + offset[1];

    if (left + tipRect.width > containerRect.left + containerRect.width) {
      left =
        containerRect.left + originPosition.left - tipRect.width - offset[0];
    }

    if (top + tipRect.height > containerRect.top + containerRect.height) {
      top = containerRect.top + originPosition.top - tipRect.height - offset[1];
    }

    left = Math.max(left, containerRect.left);
    top = Math.max(top, containerRect.top);

    return { left, top };
  }

  /**
   * Add an event listener to the instance.
   */
  on(type: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listenersMap.get(type);

    if (!listeners) {
      this.worker.postMessage({
        type: "addEventListener",
        event: type,
      });
      this.listenersMap.set(type, [listener]);
    } else {
      listeners.push(listener);
      this.listenersMap.set(type, listeners);
    }
  }

  /**
   * Remove an event listener from the instance.
   */
  off(type: string, listener?: (...args: unknown[]) => void): void {
    const listeners = this.listenersMap.get(type);
    if (!listeners) {
      return;
    }

    if (listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }

    if (listeners.length === 0 || !listener) {
      this.listenersMap.delete(type);
      this.worker.postMessage({
        type: "removeEventListener",
        event: type,
      });
    }
  }

  resize(...args: Parameters<ECharts["resize"]>): void {
    args[0] ??= {};
    args[0].width ??= this.canvas.getBoundingClientRect().width;
    args[0].height ??= this.canvas.getBoundingClientRect().height;

    this.worker.postMessage({
      type: "resize",
      args,
    });
  }

  /**
   * Set option for the instance.
   */
  setOption(
    option: echarts.EChartsOption,
    notMerge?: boolean,
    lazyUpdate?: boolean
  ): void;
  setOption(option: echarts.EChartsOption, opts?: echarts.SetOptionOpts): void;
  setOption(
    option: echarts.EChartsOption,
    arg2?: boolean | echarts.SetOptionOpts,
    arg3?: boolean
  ): void {
    this.worker.postMessage({
      type: "render",
      args: JSON.stringify([option, arg2, arg3]),
    });
  }

  /**
   * Show loading.
   */
  showLoading(cfg?: object): void;
  showLoading(name?: string, cfg?: object): void;
  showLoading(arg1?: string | object, arg2?: object): void {
    this.worker.postMessage({
      type: "showLoading",
      args: [arg1, arg2],
    });
  }

  /**
   * Hide loading.
   */
  hideLoading(...args: Parameters<ECharts["hideLoading"]>): void {
    this.worker.postMessage({
      type: "hideLoading",
      args,
    });
  }

  /**
   * Dispose the instance.
   */
  dispose(): void {
    this.canvas.remove();
    this.tipDom?.remove();
    this.worker.postMessage({
      type: "dispose",
    });
  }

  public customRender(params: Record<string, unknown>): void {
    this.worker.postMessage({
      type: "customRender",
      args: params,
    });
  }

  public async getOption(): Promise<echarts.EChartsOption> {
    return await new Promise((resolve) => {
      this.worker.addEventListener(
        "message",
        (event: MessageEvent<{ type: string; data: unknown }>) => {
          if (event.data.type !== "getOption") {
            return;
          }

          resolve(parse(event.data.data as string) as echarts.EChartsOption);
        },
        { once: true }
      );

      this.worker.postMessage({
        type: "getOption",
      });
    });
  }
}
