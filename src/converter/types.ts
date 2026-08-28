export interface SubscriptionConverter {
  readonly id: string;
  canConvert(input: string, contentType: string | null): boolean;
  convert(input: string): string;
}

export class UnsupportedSubscriptionError extends Error {
  constructor(message = "无法安全识别上游订阅格式") {
    super(message);
    this.name = "UnsupportedSubscriptionError";
  }
}
