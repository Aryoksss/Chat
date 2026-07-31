declare module 'qrcode' {
  export function toFile(
    path: string,
    text: string,
    options?: any
  ): Promise<void>;

  export function toDataURL(
    text: string,
    options?: any
  ): Promise<string>;
}
