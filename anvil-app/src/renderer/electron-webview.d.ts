export {};

declare global {
  interface HTMLWebViewElement extends HTMLElement {
    getWebContentsId(): number;
    executeJavaScript<T = unknown>(code: string): Promise<T>;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
  }

  namespace Electron {
    type WebviewTag = HTMLWebViewElement;

    interface DidNavigateEvent extends Event {
      url: string;
    }

    interface PageTitleUpdatedEvent extends Event {
      title: string;
    }
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLWebViewElement>,
        HTMLWebViewElement
      > & {
        src?: string;
        allowpopups?: string | boolean;
      };
    }
  }
}
