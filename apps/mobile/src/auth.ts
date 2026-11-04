import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import { normalizeBackendUrl, type AuthHeadersProvider } from "./api";

export function createNativeAuth(value: string) {
  const baseURL = normalizeBackendUrl(value);
  const originKey = [...baseURL]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return createAuthClient({
    baseURL,
    plugins: [
      expoClient({
        scheme: "vuzmi",
        cookiePrefix: "vuzmi",
        storagePrefix: `vuzmi_${originKey}`,
        storage: SecureStore,
      }),
    ],
  });
}
export type NativeAuthClient = ReturnType<typeof createNativeAuth>;
export function sessionHeaders(client: NativeAuthClient): AuthHeadersProvider {
  return async () => {
    const cookie = await client.getCookie();
    return { ...(cookie ? { Cookie: cookie } : {}), Origin: "vuzmi://" };
  };
}
