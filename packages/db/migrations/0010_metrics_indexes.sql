CREATE INDEX "run_steps_finished_idx" ON "run_steps" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "runs_finished_idx" ON "runs" USING btree ("finished_at");