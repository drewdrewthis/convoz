import type { Story } from "@ladle/react";
import { Field } from "./Field.tsx";

export const Plain: Story = () => <Field label="Agent handle" />;
export const WithHint: Story = () => <Field label="Agent handle" hint="2 to 40 characters from a-z, 0-9 and -." />;
