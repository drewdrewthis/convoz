import { useEffect, useState } from "react";
import { call, client } from "../../shared/api.ts";

/** useVoiceOn asks the server, once per opening of a conversation, whether a call can work now (a key, and transcription not off). */
export function useVoiceOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    call(client.GET("/api/voice"))
      .then((v) => live && setOn(v.on))
      .catch(() => {}); // offline or refused: no Call button
    return () => {
      live = false;
    };
  }, []);
  return on;
}
