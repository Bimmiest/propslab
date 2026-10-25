export function run(
  args: string[],
  io: {
    show: (baseRef: string, file: string) => string | null;
    read: (file: string) => string;
    out: (line: string) => void;
    err: (line: string) => void;
  },
): Promise<number>;
