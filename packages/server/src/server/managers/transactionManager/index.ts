import { TransactionPromise } from "./transactionPromise";

export class TransactionManager {
    promises: TransactionPromise[] = [];

    add(promise: TransactionPromise) {
        // Echo: drop settled transactions so the list doesn't grow for ever.
        const cutoff = Date.now() - 10 * 60_000;
        this.promises = this.promises.filter(p => !p.isResolved || p.createdAt > cutoff);
        this.promises.push(promise);
    }

    findIndex(transactionId: string, includeResolved = false): number {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(transactionId)) {
                return i;
            }
        }

        return -1;
    }

    find(transactionId: string, includeResolved = false): TransactionPromise {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(transactionId)) {
                return this.promises[i];
            }
        }

        return null;
    }
}
