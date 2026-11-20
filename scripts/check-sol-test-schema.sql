-- Run only in the disposable Sol migration rehearsal, never the company's database.
DO $$
BEGIN
  IF current_database() <> 'deepflare_v2_test' THEN
    RAISE EXCEPTION 'Expected disposable Sol test database';
  END IF;
  IF to_regclass('novart_preview_df_2_sol."StudioGenerationRequest"') IS NULL
     OR to_regclass('novart_preview_df_2_sol."DeepFlareWorkOrderDispatch"') IS NULL
     OR to_regclass('novart_preview_df_2_sol._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'Expected native generation, Sol and migration tables in preview schema';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public') THEN
    RAISE EXCEPTION 'Migrations wrote outside the disposable preview schema';
  END IF;
END $$;
