import { Button } from "@convoz/ui/Button";

/** NotFound is the 404 page of a conversation that does not exist or is not the owner's (the server answers it with 404). */
export function NotFound() {
  return (
    <div className="emptystate">
      <p className="lead">This conversation does not exist, or it is not yours.</p>
      <Button variant="primary" className="mt-8 min-w-[12rem] w-auto!" href="/chats">
        Back to Conversations
      </Button>
    </div>
  );
}
