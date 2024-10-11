/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */

import type { ECharts, EChartsOption, init, zrender } from "echarts";
import * as echarts from "echarts";
import { parse, stringify } from "telejson";

type InitOption = Parameters<typeof init>[2];
type EventType = Parameters<zrender.ZRenderType["handler"]["dispatch"]>[0];

type Message =
  | {
      type: "resize";
      args: Parameters<ECharts["resize"]>;
    }
  | {
      type: "render";
      args: Parameters<ECharts["setOption"]>;
    }
  | {
      type: "event";
      event: MouseEvent;
    }
  | {
      type: "dispose";
    }
  | {
      type: "addEventListener";
      event: string;
    }
  | {
      type: "removeEventListener";
      event: string;
    }
  | {
      type: "showLoading";
      args: Parameters<ECharts["showLoading"]>;
    }
  | {
      type: "hideLoading";
      args: Parameters<ECharts["hideLoading"]>;
    }
  | {
      type: "customRender";
      args: unknown;
    }
  | {
      type: "getOption";
    };

type InitMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  theme: string | EChartsOption;
  option: Parameters<typeof init>[2];
};

export default class CanvasEChartsWorker {
  static init(): void {
    self.addEventListener("message", (event) => {
      if (event.data.type === "init") {
        const initEvent = event as MessageEvent<InitMessage>;
        const instance = new this();
        instance.initialize(
          initEvent.data.canvas,
          initEvent.data.theme,
          initEvent.data.option
        );
      }
    });
  }

  echarts: ECharts | null = null;

  constructor() {
    echarts.setPlatformAPI({
      createCanvas() {
        return new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement;
      },
    });

    self.addEventListener("message", (event: MessageEvent<Message>) => {
      this.onMessageHandler(event);
    });
  }

  /**
   * Handle the message from the main thread.
   */
  onMessageHandler({ data }: MessageEvent<Message>): void {
    switch (data.type) {
      case "resize": {
        this.echarts?.resize(...data.args);
        return;
      }
      case "render": {
        this.render(
          ...(parse(data.args as unknown as string) as Parameters<
            ECharts["setOption"]
          >)
        );
        return;
      }
      case "event": {
        this.handleEvent(data.event);
        return;
      }
      case "dispose": {
        this.dispose();
        return;
      }
      case "addEventListener": {
        this.addEventListener(data.event);
        return;
      }
      case "removeEventListener": {
        this.removeEventListener(data.event);
        return;
      }
      case "showLoading":
        return this.echarts?.showLoading(...data.args);
      case "hideLoading":
        return this.echarts?.hideLoading(...data.args);
      case "customRender":
        if (data.args instanceof ArrayBuffer) {
          const decoder = new TextDecoder();
          const str = decoder.decode(data.args);
          data.args = parse(str as unknown as string);
        }

        this.customRender(data.args);
        return;
      case "getOption":
        this.sendOptionMessage();
        return;
    }
  }

  /**
   * Initialize the chart instance.
   */
  initialize(
    canvas: OffscreenCanvas,
    theme: string | EChartsOption,
    option: InitOption = {}
  ): void {
    this.echarts?.dispose();

    const devicePixelRatio = option.devicePixelRatio ?? 1;
    option.width ??= canvas.width / devicePixelRatio;
    option.height ??= canvas.height / devicePixelRatio;

    this.echarts = echarts.init(
      canvas as unknown as HTMLDivElement,
      theme,
      option
    );

    self.postMessage({
      type: "initialized",
    });
  }

  render(...args: Parameters<ECharts["setOption"]>): void {
    this.sendEventMessage("optionChange", stringify(args[0]));
    this.echarts?.setOption(...args);
  }

  /**
   * Handle mouse events from the main thread.
   */
  handleEvent(event: MouseEvent): void {
    const newEvent = Object.assign(
      // the name of wheel event in zrender is mousewheel.
      new Event(event.type === "wheel" ? "mousewheel" : event.type, event),
      {
        zrX: event.offsetX,
        zrY: event.offsetY,
        zrDelta: (event as any).wheelDelta,
      }
    );

    this.echarts
      ?.getZr()
      .handler.dispatch(newEvent.type as EventType, newEvent);
  }

  /**
   * Dispose of the chart instance
   * and stop the worker.
   */
  dispose(): void {
    this.echarts?.dispose();
    self.close();
  }

  /**
   * Register events to the main thread.
   */
  addEventListener(type: string): void {
    this.echarts?.on(type, (event) => {
      this.sendEventMessage(type, {
        ...(event as Record<string, unknown>),
        event: null,
      });
    });
  }

  sendEventMessage(type: string, data: unknown): void {
    self.postMessage({
      type: `echarts:${type}`,
      data,
    });
  }

  sendOptionMessage(): void {
    const option = this.echarts?.getOption();
    self.postMessage({
      type: "getOption",
      data: stringify(option),
    });
  }

  /**
   * Remove events to the main thread.
   */
  removeEventListener(type: string): void {
    this.echarts?.off(type);
  }

  customRender(_args: unknown): void {
    console.warn("customRender is not implemented yet");
  }
}
