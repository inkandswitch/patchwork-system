type WebSocketEndpoint<Transport> = {
  readonly url: string;
  connect(): Promise<Transport>;
  shutdown?(): void;
};

/**
 * Defers opening a WebSocket until the supplied startup work has completed.
 */
export class DeferredWebSocketEndpoint<Transport>
  implements WebSocketEndpoint<Transport>
{
  constructor(
    private endpoint: WebSocketEndpoint<Transport>,
    private ready: Promise<void>
  ) {}

  get url(): string {
    return this.endpoint.url;
  }

  async connect(): Promise<Transport> {
    await this.ready;
    return this.endpoint.connect();
  }

  shutdown(): void {
    this.endpoint.shutdown?.();
  }
}
