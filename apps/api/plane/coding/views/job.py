# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Coding jobs on one work item: list, start, read, cancel, retry."""

from functools import cached_property

from rest_framework import status
from rest_framework.response import Response

from plane.coding.exceptions import NotFound
from plane.coding.models import CodingAction, CodingJob, JobStatus
from plane.coding.serializers import CodingJobSerializer, RetryJobSerializer, StartJobSerializer
from plane.coding.services import cancel_job, retry_job, start_job

from .base import CodingEndpointMixin


class _WorkItemJobs(CodingEndpointMixin):
    @cached_property
    def issue(self):
        return self.access.visible_issue(self.kwargs["issue_id"])

    def get_job(self) -> CodingJob:
        issue = self.issue
        job = (
            CodingJob.objects.select_related("issue", "issue__project")
            .filter(pk=self.kwargs["job_id"], issue=issue)
            .first()
        )
        if job is None:
            raise NotFound("Coding job not found.")
        return job


class CodingJobListMixin(_WorkItemJobs):
    def get(self, request, slug, project_id, issue_id):
        """The work item's jobs, newest first. Filter with `status` and `action`."""
        queryset = CodingJob.objects.filter(issue=self.issue)
        errors = {}
        for field, choices in (("status", JobStatus), ("action", CodingAction)):
            value = request.GET.get(field)
            if not value:
                continue
            if value not in choices.values:
                errors[field] = [f"Must be one of {', '.join(choices.values)}."]
            queryset = queryset.filter(**{field: value})
        if errors:
            return self.invalid(errors)
        return self.paginate(
            request=request,
            queryset=queryset,
            order_by="-created_at",
            on_results=lambda jobs: CodingJobSerializer(jobs, many=True).data,
            default_per_page=50,
            max_per_page=100,
        )

    def post(self, request, slug, project_id, issue_id):
        """Start a job. Members and admins only; the project must have coding jobs set up."""
        issue = self.issue
        self.access.require_write()
        serializer = StartJobSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        job = start_job(issue, data["action"], data["agent"], request.user, machine_id=data.get("machine"))
        return Response(CodingJobSerializer(job).data, status=status.HTTP_201_CREATED)


class CodingJobDetailMixin(_WorkItemJobs):
    def get(self, request, slug, project_id, issue_id, job_id):
        return Response(CodingJobSerializer(self.get_job()).data)


class CodingJobCancelMixin(_WorkItemJobs):
    def post(self, request, slug, project_id, issue_id, job_id):
        """Cancel an active job: the person who started it, or a project admin."""
        job = self.get_job()
        self.access.require_write()
        if job.requested_by_id != request.user.id and not self.access.is_admin:
            return Response(
                {"error": "Only the person who started this job or a project admin can cancel it."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return Response(CodingJobSerializer(cancel_job(job, request.user)).data)


class CodingJobRetryMixin(_WorkItemJobs):
    def post(self, request, slug, project_id, issue_id, job_id):
        """Start a new job like this one (`retry_of` points back), if it was cancelled or ended in a job error."""
        job = self.get_job()
        self.access.require_write()
        serializer = RetryJobSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        options = {"machine_id": data["machine"]} if "machine" in data else {}
        new_job = retry_job(job, request.user, agent=data.get("agent"), **options)
        return Response(CodingJobSerializer(new_job).data, status=status.HTTP_201_CREATED)
