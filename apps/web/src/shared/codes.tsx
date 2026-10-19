// Recovery codes: shown once, with copy and download. They live in memory only.
import { useNotice } from "./notice.tsx";
import { Button } from "@convoz/ui/Button";

export function CodesBlock({ codes }: { codes: string[] }) {
  const { say, fail } = useNotice();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      say("Copied. Keep the codes somewhere safe.");
    } catch {
      fail("Copying did not work. Select the codes and copy them by hand.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${codes.join("\n")}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "convoz-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <>
      <ol className="codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="pair">
        <Button className="flex-1" onClick={copy}>
          Copy codes
        </Button>
        <Button className="flex-1" onClick={download}>
          Download codes
        </Button>
      </div>
    </>
  );
}
