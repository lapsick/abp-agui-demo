import { HttpAgent } from '@ag-ui/client';
import { JsonPipe } from '@angular/common';
import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { bootstrapApplication } from '@angular/platform-browser';
import { marked } from 'marked';

type Product = {
  name: string;
  price: number;
  stock: number;
};

@Component({
  selector: 'app-root',
  imports: [FormsModule, JsonPipe],
  template: `
    <header>
      <h1>ABP / AG-UI Lab</h1>
      <p>Angular · Microsoft Agent Framework · SSE</p>
    </header>

    <main>
      <section>
        <h2>Catalog assistant</h2>
        <button (click)="reset()" [disabled]="busy()">New conversation</button>

        <div class="messages">
          @for (message of messages(); track message.id) {
            <article>
              <small>{{ message.role }}</small>
              <div [innerHTML]="markdown(message.content)"></div>
            </article>
          }

          @if (products().length) {
            <article>
              <h3>Catalog tool result</h3>
              <table>
                <tr>
                  <th>Product</th>
                  <th>Price (USD)</th>
                  <th>Stock</th>
                </tr>
                @for (product of products(); track product.name) {
                  <tr>
                    <td>{{ product.name }}</td>
                    <td>{{ product.price }}</td>
                    <td>{{ product.stock }}</td>
                  </tr>
                }
              </table>
            </article>
          }
        </div>

        <form (ngSubmit)="send()">
          <input
            name="prompt"
            [(ngModel)]="prompt"
            placeholder="Show me the products"
            [disabled]="busy()"
          />
          <button [disabled]="busy() || !prompt.trim()">Send</button>
          <button type="button" (click)="cancel()" [disabled]="!busy()">
            Stop
          </button>
        </form>

        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
      </section>

      <aside>
        <h2>AG-UI events</h2>
        <p>{{ events().length }} events</p>
        @for (event of events(); track $index) {
          <details>
            <summary>{{ event.type }}</summary>
            <pre>{{ event | json }}</pre>
          </details>
        }
      </aside>
    </main>
  `,
})
class App {
  private agent = this.createAgent();

  prompt = 'Show me the available products';
  busy = signal(false);
  error = signal('');
  products = signal<Product[]>([]);
  messages = signal<{ id: string; role: string; content: string }[]>([]);
  events = signal<Record<string, unknown>[]>([]);

  private createAgent() {
    return new HttpAgent({ url: '/api/agent', threadId: crypto.randomUUID() });
  }

  markdown(content: string) {
    return marked.parse(content, { async: false });
  }

  reset() {
    this.agent = this.createAgent();
    this.messages.set([]);
    this.events.set([]);
    this.products.set([]);
    this.error.set('');
  }

  cancel() {
    this.agent.abortRun();
  }

  private record(event: object) {
    this.events.update((events) => [...events, event as Record<string, unknown>]);
  }

  private sync() {
    this.messages.set(
      this.agent.messages.flatMap((message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string'
          ? [{ id: message.id, role: message.role, content: message.content }]
          : [],
      ),
    );
  }

  async send() {
    const content = this.prompt.trim();
    if (!content || this.busy()) {
      return;
    }

    this.prompt = '';
    this.busy.set(true);
    this.error.set('');
    this.agent.addMessage({ id: crypto.randomUUID(), role: 'user', content });
    this.sync();
    const runId = crypto.randomUUID();

    try {
      await this.agent.runAgent(
        { runId },
        {
          onMessagesChanged: () => this.sync(),
          onRunStartedEvent: ({ event }) => this.record(event),
          onTextMessageStartEvent: ({ event }) => this.record(event),
          onTextMessageContentEvent: ({ event }) => this.record(event),
          onTextMessageEndEvent: ({ event }) => this.record(event),
          onToolCallStartEvent: ({ event }) => this.record(event),
          onToolCallArgsEvent: ({ event }) => this.record(event),
          onToolCallEndEvent: ({ event }) => this.record(event),
          onToolCallResultEvent: ({ event }) => {
            this.record(event);

            if (typeof event.content !== 'string') {
              return;
            }

            try {
              let value = JSON.parse(event.content);
              if (typeof value === 'string') {
                value = JSON.parse(value);
              }

              if (
                Array.isArray(value) &&
                value.every(
                  (product) =>
                    product &&
                    typeof product.name === 'string' &&
                    typeof product.price === 'number' &&
                    typeof product.stock === 'number',
                )
              ) {
                this.products.set(value);
              }
            } catch {
              // Other tool results remain in the inspector.
            }
          },
          onRunFinishedEvent: ({ event }) => this.record(event),
          onRunErrorEvent: ({ event }) => {
            this.record(event);
            this.error.set(
              event.code === 'StreamingError'
                ? `${event.message} See the server terminal for the underlying error (run ${runId}).`
                : event.message,
            );
          },
        },
      );
    } catch (error) {
      if (!this.error()) {
        this.error.set(String(error));
      }
    } finally {
      this.sync();
      this.busy.set(false);
    }
  }
}

bootstrapApplication(App).catch(console.error);
