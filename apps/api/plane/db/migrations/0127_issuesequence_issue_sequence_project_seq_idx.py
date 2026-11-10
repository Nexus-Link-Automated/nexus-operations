from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    # Required by AddIndexConcurrently. A failed build leaves an INVALID index; before retrying, run
    # DROP INDEX CONCURRENTLY IF EXISTS issue_sequence_project_seq_idx;
    atomic = False

    dependencies = [
        ("db", "0126_agentprovidercredential"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="issuesequence",
            index=models.Index(fields=["project", "sequence"], name="issue_sequence_project_seq_idx"),
        ),
    ]
