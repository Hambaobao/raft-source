CREATE TABLE "agent_message_body_reads" (
	"agent_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"launch_id" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_message_body_reads_agent_id_message_id_pk" PRIMARY KEY("agent_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "agent_message_body_reads" ADD CONSTRAINT "agent_message_body_reads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message_body_reads" ADD CONSTRAINT "agent_message_body_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_message_body_reads_message" ON "agent_message_body_reads" USING btree ("message_id");