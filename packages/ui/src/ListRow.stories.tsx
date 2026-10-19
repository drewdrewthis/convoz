import type { Story } from "@ladle/react";
import { Button } from "./Button.tsx";
import { List, ListRow } from "./ListRow.tsx";

// One story, so the story book's axe check (every theme, palette and size) stays within its time: the rows of each kind, in the lists they live in.
export const Rows: Story = () => (
  <div className="flex flex-col">
    <List as="div" aria-label="Links">
      <ListRow as="a" href="/settings" title="Settings" chevron />
      <ListRow as="button" title="Advanced" chevron />
      <ListRow as="button" tone="danger">Sign out</ListRow>
    </List>
    <List aria-label="Trash">
      <ListRow title="Team updates" sub="deleted forever in 29 days" trailing={<Button size="small" aria-label="Restore Team updates">Restore</Button>} />
      <ListRow leading={<span aria-hidden="true">N</span>} title="Why did the nightly export get slower?" sub="lane-search: It started after the cache change" unread />
      <ListRow leading={<span aria-hidden="true">O</span>} title="Ops reports" sub="night-watch: Deploy finished" selected />
    </List>
    <List aria-label="Sessions">
      <ListRow stacked>
        <strong>convoz cli</strong>
        <span className="text-13 text-muted">on box-2 · last seen just now</span>
      </ListRow>
    </List>
  </div>
);
