import { Message } from "@server/databases/imessage/entity/Message";
import { MessagePromise } from "./messagePromise";

export class OutgoingMessageManager {
    promises: MessagePromise[] = [];

    add(promise: MessagePromise) {
        // Echo: settled sends used to be kept forever, so the list grew with every
        // message ever sent. Keep the last ten minutes of them for late matches.
        const cutoff = Date.now() - 10 * 60_000;
        this.promises = this.promises.filter(p => !p.isResolved || p.sentAt > cutoff);
        this.promises.push(promise);
    }

    findIndex(message: Message, includeResolved = false): number {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(message)) {
                return i;
            }
        }

        return -1;
    }

    find(message: Message, includeResolved = false): MessagePromise {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(message)) {
                return this.promises[i];
            }
        }

        return null;
    }

    async resolve(message: Message): Promise<boolean> {
        const idx = this.findIndex(message);
        if (idx >= 0) {
            await this.promises[idx].resolve(message);
            return true;
        }

        return false;
    }

    async reject(reason: any, message: Message): Promise<boolean> {
        const idx = this.findIndex(message);
        if (idx >= 0) {
            await this.promises[idx].reject(reason, message);
            return true;
        }

        return false;
    }
}
