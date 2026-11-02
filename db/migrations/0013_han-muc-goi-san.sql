CREATE TABLE "channel"."api_usage" (
	"platform" "channel"."marketplace" NOT NULL,
	"day" date NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "api_usage_platform_day_pk" PRIMARY KEY("platform","day")
);
