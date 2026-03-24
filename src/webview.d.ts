declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        autosize?: string;
        allowpopups?: string;
      },
      HTMLElement
    >;
  }
}
