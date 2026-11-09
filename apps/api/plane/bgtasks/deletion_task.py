# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.utils import timezone
from django.apps import apps
from django.conf import settings
from django.db import models, transaction
from django.db.models import Exists, OuterRef
from django.db.models.fields.related import OneToOneRel


# Third party imports
from celery import shared_task

# Module imports
from plane.utils.exception_logger import log_exception


@shared_task
def soft_delete_related_objects(app_label, model_name, instance_pk, using=None):
    """
    Soft delete related objects for a given model instance
    """
    # Get the model class using app registry
    model_class = apps.get_model(app_label, model_name)

    # Get the instance using all_objects to ensure we can get even if it's already soft deleted
    try:
        instance = model_class.all_objects.get(pk=instance_pk)
    except model_class.DoesNotExist:
        return

    # Get all related fields that are reverse relationships
    all_related = [
        f for f in instance._meta.get_fields() if (f.one_to_many or f.one_to_one) and f.auto_created and not f.concrete
    ]

    # Handle each related field
    for relation in all_related:
        related_name = relation.get_accessor_name()

        # Skip if the relation doesn't exist
        if not hasattr(instance, related_name):
            continue

        # Get the on_delete behavior name
        on_delete_name = relation.on_delete.__name__ if hasattr(relation.on_delete, "__name__") else ""

        if on_delete_name == "DO_NOTHING":
            continue

        elif on_delete_name == "SET_NULL":
            # Handle SET_NULL relationships
            if isinstance(relation, OneToOneRel):
                # For OneToOne relationships
                related_obj = getattr(instance, related_name, None)
                if related_obj and isinstance(related_obj, models.Model):
                    setattr(related_obj, relation.remote_field.name, None)
                    related_obj.save(update_fields=[relation.remote_field.name])
            else:
                # For other relationships
                related_queryset = getattr(instance, related_name).all()
                related_queryset.update(**{relation.remote_field.name: None})

        else:
            # Handle CASCADE and other delete behaviors
            try:
                if relation.one_to_one:
                    # Handle OneToOne relationships
                    related_obj = getattr(instance, related_name, None)
                    if related_obj:
                        if hasattr(related_obj, "deleted_at"):
                            if not related_obj.deleted_at:
                                related_obj.deleted_at = timezone.now()
                                related_obj.save()
                                # Recursively handle related objects
                                soft_delete_related_objects(
                                    related_obj._meta.app_label,
                                    related_obj._meta.model_name,
                                    related_obj.pk,
                                    using,
                                )
                else:
                    # Handle other relationships
                    related_queryset = getattr(instance, related_name)(manager="objects").all()

                    for related_obj in related_queryset:
                        if hasattr(related_obj, "deleted_at"):
                            if not related_obj.deleted_at:
                                related_obj.deleted_at = timezone.now()
                                related_obj.save()
                                # Recursively handle related objects
                                soft_delete_related_objects(
                                    related_obj._meta.app_label,
                                    related_obj._meta.model_name,
                                    related_obj.pk,
                                    using,
                                )
            except Exception as e:
                # Log the error or handle as needed
                print(f"Error handling relation {related_name}: {str(e)}")
                continue

    # Finally, soft delete the instance itself if it hasn't been deleted yet
    if hasattr(instance, "deleted_at") and not instance.deleted_at:
        instance.deleted_at = timezone.now()
        instance.save()


# @shared_task
def restore_related_objects(app_label, model_name, instance_pk, using=None):
    pass


def purge_expired_rows(model, cutoff):
    """
    Hard delete one model's rows that were soft deleted before the cutoff.

    Each model gets its own transaction, and a failure is logged so that it cannot
    stop the models after it.
    """
    from plane.db.models import Issue, IssueActivity, IssueComment

    try:
        with transaction.atomic():
            if model is Issue:
                # A bulk delete soft deletes a parent but not its sub-issues, and Issue.parent
                # cascades. A sub-issue that is not past retention has to outlive its parent.
                Issue.all_objects.filter(parent__deleted_at__lt=cutoff).exclude(deleted_at__lt=cutoff).update(
                    parent=None
                )

            deleted, _ = model.all_objects.filter(deleted_at__lt=cutoff).delete()

            if deleted:
                # IssueActivity history outlives what it describes through DO_NOTHING foreign keys,
                # whichever cascade removed the row. Those constraints are checked at commit, so any
                # reference without a target here points at a row deleted in this transaction.
                for field, target in (("issue", Issue), ("issue_comment", IssueComment)):
                    IssueActivity.all_objects.filter(
                        ~Exists(target.all_objects.filter(pk=OuterRef(f"{field}_id"))),
                        **{f"{field}__isnull": False},
                    ).update(**{field: None})
    except Exception as e:
        log_exception(e)


@shared_task
def hard_delete():
    from plane.db.models import (
        Workspace,
        Project,
        Cycle,
        Module,
        Issue,
        Page,
        IssueView,
        Label,
        State,
        IssueActivity,
        IssueComment,
        IssueLink,
        IssueReaction,
        UserFavorite,
        ModuleIssue,
        CycleIssue,
        Estimate,
        EstimatePoint,
    )

    days = settings.HARD_DELETE_AFTER_DAYS
    cutoff = timezone.now() - timezone.timedelta(days=days)
    # check delete workspace
    purge_expired_rows(Workspace, cutoff)

    # check delete project
    purge_expired_rows(Project, cutoff)

    # check delete cycle
    purge_expired_rows(Cycle, cutoff)

    # check delete module
    purge_expired_rows(Module, cutoff)

    # check delete issue
    purge_expired_rows(Issue, cutoff)

    # check delete page
    purge_expired_rows(Page, cutoff)

    # check delete view
    purge_expired_rows(IssueView, cutoff)

    # check delete label
    purge_expired_rows(Label, cutoff)

    # check delete state
    purge_expired_rows(State, cutoff)

    purge_expired_rows(IssueActivity, cutoff)

    purge_expired_rows(IssueComment, cutoff)

    purge_expired_rows(IssueLink, cutoff)

    purge_expired_rows(IssueReaction, cutoff)

    purge_expired_rows(UserFavorite, cutoff)

    purge_expired_rows(ModuleIssue, cutoff)

    purge_expired_rows(CycleIssue, cutoff)

    purge_expired_rows(Estimate, cutoff)

    purge_expired_rows(EstimatePoint, cutoff)

    # at last, check for every thing which ever is left and delete it
    # Get all Django models
    all_models = apps.get_models()

    # Iterate through all models
    for model in all_models:
        # Check if the model has a 'deleted_at' field
        if hasattr(model, "deleted_at"):
            # Get all instances where 'deleted_at' is greater than 30 days ago
            purge_expired_rows(model, cutoff)

    return
